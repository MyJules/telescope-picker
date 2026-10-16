import * as vscode from 'vscode';
import { PickerController } from './controller';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Telescope Picker');
  const controller = new PickerController(context, output);
  context.subscriptions.push(output, controller,
    vscode.commands.registerCommand('telescopePicker.configureShortcuts', () =>
      vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', '@ext:local.telescope-picker')),
    vscode.commands.registerCommand('telescopePicker.files', () => controller.show()),
    vscode.commands.registerCommand('telescopePicker.searchContents', (query?: unknown) => {
      if (query !== undefined && typeof query !== 'string') throw new Error('Content-search query must be a string.');
      return controller.show(false, 'contents', query);
    }),
    vscode.commands.registerCommand('telescopePicker.searchCurrentFile', (query?: unknown) => {
      if (query !== undefined && typeof query !== 'string') throw new Error('Current-file query must be a string.');
      return controller.show(false, 'currentFile', query);
    }),
    vscode.commands.registerCommand('telescopePicker.resume', () => controller.show(true)),
    vscode.commands.registerCommand('telescopePicker.openBeside', () => controller.openBeside()),
    vscode.commands.registerCommand('telescopePicker.next', () => controller.navigate(1)),
    vscode.commands.registerCommand('telescopePicker.previous', () => controller.navigate(-1)));
}
