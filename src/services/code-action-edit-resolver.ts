import { CancellationError, CancellationToken, WorkspaceEdit } from 'vscode';
import { CodeAction } from '../types';
import { Request } from '../phpcs-report/request';
import { ReportType } from '../phpcs-report/response';
import { WorkerService } from './worker-service';
import { PHPCSError } from '../phpcs-report/worker';
import { ConfigurationError } from './configuration';

/**
 * A class for resolving edits for code actions.
 */
export class CodeActionEditResolver extends WorkerService {
	/**
	 * Resolves a code action's edit property.
	 *
	 * @param {CodeAction} codeAction The code action that we're going to resolve.
	 * @param {CancellationToken} [parentCancellationToken] The optional cancellation token to add.
	 */
	public resolve(
		codeAction: CodeAction,
		parentCancellationToken?: CancellationToken
	): Promise<CodeAction> {
		// We can't resolve the code action if it isn't valid.
		if (
			!codeAction.document ||
			!codeAction.diagnostics ||
			codeAction.diagnostics.length != 1
		) {
			return Promise.resolve(codeAction);
		}

		const cancellationToken = this.createCancellationToken(
			codeAction.document,
			parentCancellationToken
		);
		if (!cancellationToken) {
			return Promise.resolve(codeAction);
		}

		// Use a consistent key to prevent overlap when resolving the code action.
		const document = codeAction.document;
		const diagnostic = codeAction.diagnostics[0];

		return this.configuration
			.get(document, cancellationToken)
			.then(() => {
				const workerKey = [
					'resolve',
					document.fileName,
					diagnostic.code as string,
					diagnostic.range.start.line,
					diagnostic.range.start.character,
				].join(':');

				return this.workerPool.waitForAvailable(
					workerKey,
					cancellationToken
				);
			})
			.then(async (worker) => {
				const workspaceUri =
					this.workspaceLocator.getWorkspaceFolderOrDefault(
						document.uri
					);
				const config = await this.configuration.get(document);

				// Use the worker to make a request for a code action report.
				const request: Request<ReportType.CodeAction> = {
					type: ReportType.CodeAction,
					workingDirectory: workspaceUri.fsPath,
					documentPath: document.uri.fsPath,
					documentContent: document.getText(),
					options: {
						executable: config.executable,
						standard: config.standard,
					},
					data: {
						code: diagnostic.code as string,
						line: diagnostic.range.start.line,
						character: diagnostic.range.start.character,
					},
				};

				return worker.execute(request, cancellationToken);
			})
			.then((response) => {
				this.deleteCancellationToken(document);

				// Pass the workspace edit to the requester.
				if (response.report) {
					codeAction.edit = new WorkspaceEdit();
					codeAction.edit.set(document.uri, response.report.edits);
				}

				return codeAction;
			})
			.catch((e) => {
				// Cancellation errors are acceptable as they mean we've just repeated the update before it completed.
				if (e instanceof CancellationError) {
					return codeAction;
				}

				// Configuration errors should be logged and presented to the user.
				if (e instanceof ConfigurationError) {
					this.logger.error(e);
					return codeAction;
				}

				// We should send PHPCS errors to be logged and presented to the user.
				if (e instanceof PHPCSError) {
					this.logger.error(e);
					return codeAction;
				}

				throw e;
			});
	}
}
