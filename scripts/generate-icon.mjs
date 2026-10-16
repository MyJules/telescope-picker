import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile } from 'node:fs/promises';

const source = new URL('../media/icon.svg', import.meta.url);
const destination = new URL('../media/icon.png', import.meta.url);
const svg = await readFile(source, 'utf8');
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng();
await writeFile(destination, png);
console.log('Generated media/icon.png (256 x 256) from media/icon.svg.');
