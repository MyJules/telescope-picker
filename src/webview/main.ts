import { startPicker, type Host } from './picker';

declare function acquireVsCodeApi(): Host;

startPicker(acquireVsCodeApi(), document, window);
