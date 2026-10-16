import * as vscode from 'vscode';
import { PickerController } from './controller';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Telescope Picker');
  const controller = new PickerController(context, output);
  context.subscriptions.push(output, controller,
    vscode.commands.registerCommand('telescopePicker.files', () => controller.show()),
    vscode.commands.registerCommand('telescopePicker.resume', () => controller.show(true)));
}
