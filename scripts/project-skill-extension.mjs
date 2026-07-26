#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectProjectSkillExtension } from '../src/lib/projectSkillExtension.mjs';
import { readComposedSkillRegistry } from '../src/lib/skillRegistry.mjs';

const CORE_REGISTRY = '.claude/skills/skill-manifest.json';

function argumentsFor(argv) {
  const args = [...argv];
  if (args.shift() !== 'inspect') {
    throw new Error('usage: project-skill-extension.mjs inspect --skill <name> [--root <path>] --json');
  }
  const options = { root: process.cwd(), json: false };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--skill') options.skill = args.shift();
    else if (flag === '--root') options.root = resolve(args.shift());
    else if (flag === '--json') options.json = true;
    else throw new Error(`unknown option: ${flag}`);
  }
  if (!options.skill) throw new Error('--skill is required');
  if (!options.json) throw new Error('--json is required');
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  let activation;
  try {
    const core = JSON.parse(await readFile(join(options.root, CORE_REGISTRY), 'utf8'));
    const registry = await readComposedSkillRegistry(options.root, core);
    const matches = Object.values(registry.readiness?.capabilities ?? {})
      .map((capability) => capability?.evidence)
      .filter((evidence) =>
        evidence?.type === 'project-extension' && evidence.skill === options.skill);
    if (matches.length > 1) {
      throw new Error(`multiple Project extension activation policies for ${options.skill}`);
    }
    activation = matches[0]?.activation;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return inspectProjectSkillExtension({ ...options, activation });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.log(JSON.stringify({ state: 'blocked', diagnostic: error.message }));
      process.exitCode = 1;
    },
  );
}
