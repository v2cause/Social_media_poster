import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { isStructurallySame, parse, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';

// Guide step 1.10: the messages of the web app are complete and consistent in every language.
//
//   - every language has the same namespace files (messages/<language>/<namespace>.json),
//   - every key of the reference language (German) exists in every other language, and no
//     language has keys the reference lacks,
//   - every message is non-empty, valid ICU, and plural or select messages have an "other" case,
//   - a message uses the same arguments with the same types in every language, so {count} in
//     German is no {n} in English.
//
// Usage: tsx tools/check-i18n.ts [messages directory]   (default: apps/web/messages)

const REFERENCE = 'de';
const DEFAULT_DIRECTORY = 'apps/web/messages';

/** Dotted key (namespace.path.to.key) to message. */
type Catalog = Map<string, string>;

async function listDirectory(path: string): Promise<{ name: string; isDirectory: boolean }[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
}

function flatten(value: unknown, key: string, catalog: Catalog, problems: string[], file: string): void {
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      problems.push(`${file}: "${key}" is empty`);
    }
    catalog.set(key, value);
    return;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [child, childValue] of Object.entries(value)) {
      flatten(childValue, `${key}.${child}`, catalog, problems, file);
    }
    return;
  }
  problems.push(`${file}: "${key}" must be a message or an object of messages`);
}

async function loadLanguage(directory: string, language: string, root: string, problems: string[]) {
  const namespaces = new Map<string, Catalog>();
  for (const entry of await listDirectory(join(directory, language))) {
    if (entry.isDirectory || !entry.name.endsWith('.json')) {
      continue;
    }
    const namespace = entry.name.slice(0, -'.json'.length);
    const path = join(directory, language, entry.name);
    const file = relative(root, path);
    const catalog: Catalog = new Map();
    try {
      const content: unknown = JSON.parse(await readFile(path, 'utf8'));
      flatten(content, namespace, catalog, problems, file);
    } catch (error) {
      problems.push(`${file}: invalid JSON (${error instanceof Error ? error.message : 'unknown error'})`);
    }
    namespaces.set(namespace, catalog);
  }
  return namespaces;
}

function parseMessage(
  message: string,
  where: string,
  problems: string[],
): MessageFormatElement[] | undefined {
  try {
    return parse(message, { requiresOtherClause: true });
  } catch (error) {
    problems.push(
      `${where}: invalid ICU message (${error instanceof Error ? error.message : 'unknown error'})`,
    );
    return undefined;
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  const directory = resolve(root, process.argv[2] ?? DEFAULT_DIRECTORY);
  const problems: string[] = [];

  const languages = (await listDirectory(directory))
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .sort();
  if (!languages.includes(REFERENCE)) {
    throw new Error(`${relative(root, directory)} has no reference language "${REFERENCE}"`);
  }

  const catalogs = new Map<string, Map<string, Catalog>>();
  for (const language of languages) {
    catalogs.set(language, await loadLanguage(directory, language, root, problems));
  }
  const reference = catalogs.get(REFERENCE) ?? new Map<string, Catalog>();
  const allNamespaces = new Set([...catalogs.values()].flatMap((namespaces) => [...namespaces.keys()]));

  let keyCount = 0;
  for (const namespace of [...allNamespaces].sort()) {
    const referenceCatalog = reference.get(namespace);
    for (const language of languages) {
      const catalog = catalogs.get(language)?.get(namespace);
      const file = `${language}/${namespace}.json`;
      if (!catalog) {
        problems.push(`${file}: missing (the namespace exists in another language)`);
        continue;
      }
      if (!referenceCatalog || language === REFERENCE) {
        continue;
      }
      for (const key of referenceCatalog.keys()) {
        if (!catalog.has(key)) {
          problems.push(`${file}: missing key "${key}"`);
        }
      }
      for (const key of catalog.keys()) {
        if (!referenceCatalog.has(key)) {
          problems.push(`${file}: key "${key}" does not exist in ${REFERENCE}/${namespace}.json`);
        }
      }
    }

    if (!referenceCatalog) {
      continue;
    }
    keyCount += referenceCatalog.size;
    for (const [key, message] of referenceCatalog) {
      const referenceAst = parseMessage(message, `${REFERENCE}: "${key}"`, problems);
      for (const language of languages) {
        const other = language === REFERENCE ? undefined : catalogs.get(language)?.get(namespace)?.get(key);
        if (other === undefined) {
          continue;
        }
        const otherAst = parseMessage(other, `${language}: "${key}"`, problems);
        if (referenceAst && otherAst) {
          const result = isStructurallySame(referenceAst, otherAst);
          if (!result.success) {
            problems.push(
              `${language}: "${key}" uses other arguments than ${REFERENCE} (${result.error?.message ?? 'different structure'})`,
            );
          }
        }
      }
    }
  }

  if (problems.length > 0) {
    process.stdout.write(
      `i18n check failed with ${String(problems.length)} problem(s):\n${problems.join('\n')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `i18n check passed: ${String(languages.length)} languages (${languages.join(', ')}), ${String(allNamespaces.size)} namespaces, ${String(keyCount)} keys each.\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
