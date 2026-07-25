#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectProjectSkillExtension } from '../src/lib/projectSkillExtension.mjs';

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
  return inspectProjectSkillExtension(options);
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
