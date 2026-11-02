import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const name = `${manifest.displayName}-v${manifest.version}`;
const zip = new AdmZip();
async function add(relative) {
  const absolute = path.join(root, relative);
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) await add(child);
    else if (entry.isFile()) zip.addFile(`${name}/${child}`, await readFile(path.join(root, child)));
  }
}
for (const dir of ['dist', 'profiles', 'skills', 'src', 'scripts', 'test']) await add(dir);
for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE']) {
  zip.addFile(`${name}/${file}`, await readFile(path.join(root, file)));
}
const output = path.join(root, 'releases');
await mkdir(output, { recursive: true });
const bytes = zip.toBuffer();
const filename = `${name}.zip`;
await writeFile(path.join(output, filename), bytes);
await writeFile(path.join(output, `${filename}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${filename}\n`);
console.log(path.join(output, filename));
