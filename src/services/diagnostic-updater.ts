import {
	CancellationError,
	CodeActionKind,
	Diagnostic,
	DiagnosticCollection,
	TextDocument,
} from 'vscode';
import { CodeAction, CodeActionCollection } from '../types';
import { IgnoreLineCommand } from '../commands/ignore-line-command';
import { Configuration, ConfigurationError, LintAction } from './configuration';
import { Logger } from './logger';
import { Request } from '../phpcs-report/request';
import { ReportType } from '../phpcs-report/response';
import { PHPCSError } from '../phpcs-report/worker';
import { WorkerPool } from '../phpcs-report/worker-pool';
import { WorkerService } from './worker-service';
import { LinterStatus } from './linter-status';
import { WorkspaceLocator } from './workspace-locator';

/**
 * A custom error type for identifying when an update was prevented.
 */
class UpdatePreventedError extends Error {}

/**
 * A class for updating diagnostics and code actions.
 */
export class DiagnosticUpdater extends WorkerService {
	/**
	 * A service for keeping the user updated about the linter's activity.
	 */
	private readonly linterStatus: LinterStatus;

	/**
	 * A collection of all the diagnostics we are responsible for.
	 */
	private readonly diagnosticCollection: DiagnosticCollection;

	/**
	 * A map of all the code actions we are responsible for.
	 */
	private readonly codeActionCollection: CodeActionCollection;

	/**
	 * Constructor.
	 *
	 * @param {Logger} logger The logger to use.
	 * @param {WorkspaceLocator} workspaceLocator The workspace locator to use.
	 * @param {Configuration} configuration The configuration object to use.
	 * @param {WorkerPool} workerPool The worker pool to use.
	 * @param {LinterStatus} linterStatus The linter status service to use.
	 * @param {DiagnosticCollection} diagnosticCollection The collection of diagnostics we are responsible for.
	 * @param {CodeActionCollection} codeActionCollection The collection of code actions that we're responsible for.
	 */
	public constructor(
		logger: Logger,
		workspaceLocator: WorkspaceLocator,
		configuration: Configuration,
		workerPool: WorkerPool,
		linterStatus: LinterStatus,
		diagnosticCollection: DiagnosticCollection,
		codeActionCollection: CodeActionCollection
	) {
		super(logger, workspaceLocator, configuration, workerPool);

		this.linterStatus = linterStatus;
		this.diagnosticCollection = diagnosticCollection;
		this.codeActionCollection = codeActionCollection;
	}

	/**
	 * A handler to be called when a document is closed to clean up after it.
	 *
	 * @param {TextDocument} document The document that was closed.
	 */
	public onDocumentClosed(document: TextDocument): void {
		super.onDocumentClosed(document);
		this.clearDocument(document);
	}

	/**
	 * Clears the data stored for a document.
	 *
	 * @param {TextDocument} document The document to reset.
	 */
	public clearDocument(document: TextDocument): void {
		this.diagnosticCollection.delete(document.uri);
		this.codeActionCollection.delete(document.uri);
	}

	/**
	 * Updates a document's diagnostics.
	 *
	 * @param {TextDocument} document The document to update the diagnostics for.
	 * @param {LintAction} lintAction The editor action that triggered this update.
	 */
	public update(document: TextDocument, lintAction: LintAction): void {
		const cancellationToken = this.createCancellationToken(document);
		if (!cancellationToken) {
			return;
		}

		// Record that we're going to start linting a document.
		this.linterStatus.start(document.uri);

		// Make sure we stop linting the document the update is cancelled.
		cancellationToken.onCancellationRequested(() => {
			this.linterStatus.stop(document.uri);
		});

		this.configuration
			.get(document, cancellationToken)
			.then((configuration) => {
				// Check the file's path against our exclude patterns so that we don't process
				// diagnostics for files that the user is not interested in receiving them for.
				for (const pattern of configuration.exclude) {
					if (pattern.test(document.uri.fsPath)) {
						// When an open file wasn't excluded at first but becomes excluded, it will leave
						// behind diagnostics and code actions. To avoid this, let's always clear the
						// data for documents that are excluded from diagnostic processing.
						this.clearDocument(document);
						throw new UpdatePreventedError();
					}
				}

				// Allow users to decide when the diagnostics are updated.
				switch (lintAction) {
					case LintAction.Change:
						// Allow users to restrict updates to explicit save actions.
						if (configuration.lintAction === LintAction.Save) {
							throw new UpdatePreventedError();
						}

						break;

					case LintAction.Save:
						// When linting on change, we will always have the latest diagnostics, and don't need to update.
						if (configuration.lintAction === LintAction.Change) {
							throw new UpdatePreventedError();
						}
						break;
				}

				return this.workerPool
					.waitForAvailable(
						'diagnostic:' + document.fileName,
						cancellationToken
					)
					.then(async (worker) => {
						const workspaceUri =
							this.workspaceLocator.getWorkspaceFolderOrDefault(
								document.uri
							);

						// Use the worker to make a request for a diagnostic report.
						const request: Request<ReportType.Diagnostic> = {
							type: ReportType.Diagnostic,
							workingDirectory: workspaceUri.fsPath,
							documentPath: document.uri.fsPath,
							documentContent: document.getText(),
							options: {
								executable: configuration.executable,
								standard: configuration.standard,
							},
							data: null,
						};

						return worker.execute(request, cancellationToken);
					});
			})
			.then((response) => {
				this.deleteCancellationToken(document);

				// Let the status know we're not linting the document anymore.
				this.linterStatus.stop(document.uri);

				// When an empty response is received it means that there are no diagnostics for the file.
				if (!response.report) {
					this.clearDocument(document);
					return;
				}

				// Update the diagnostics for the document.
				this.diagnosticCollection.set(
					document.uri,
					response.report.diagnostics
				);

				// Prepare the code actions and update them for the document.
				response.report.codeActions.push(
					...this.buildDiagnosticCodeActions(
						document,
						response.report.diagnostics
					)
				);
				this.codeActionCollection.set(
					document.uri,
					response.report.codeActions
				);
			})
			.catch((e) => {
				// Cancellation errors are acceptable as they mean we've just repeated the update before it completed.
				if (e instanceof CancellationError) {
					return;
				}

				// Let the status know we're not linting the document anymore.
				this.linterStatus.stop(document.uri);

				// Configuration errors should be logged and presented to the user.
				if (e instanceof ConfigurationError) {
					this.logger.error(e);
					return;
				}

				// Updates can be prevented in expected ways, so this error is acceptable.
				if (e instanceof UpdatePreventedError) {
					return;
				}

				// We should send PHPCS errors to be logged and presented to the user.
				if (e instanceof PHPCSError) {
					this.logger.error(e);
					return;
				}

				throw e;
			});
	}

	/**
	 * Builds all of the code actions that are associated with diagnostics, such as ignore actions.
	 *
	 * @param {TextDocument} document The document that the actions are for.
	 * @param {Array.<Diagnostic>} diagnostics The diagnostics for the document.
	 */
	private buildDiagnosticCodeActions(
		document: TextDocument,
		diagnostics: Diagnostic[]
	): CodeAction[] {
		const codeActions: CodeAction[] = [];

		for (const diagnostic of diagnostics) {
			const action = new CodeAction(
				'Ignore ' + diagnostic.code + ' for this line',
				CodeActionKind.QuickFix
			);
			action.diagnostics = [diagnostic];
			action.command = {
				title: 'Ignore Laravel PHP_CodeSniffer',
				command: IgnoreLineCommand.COMMAND,
				arguments: [
					document,
					diagnostic.code,
					diagnostic.range.start.line,
				],
			};
			codeActions.push(action);
		}

		return codeActions;
	}
}
