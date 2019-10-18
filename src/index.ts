#!/usr/bin/env node
import archiver from 'archiver';
import { execSync } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, removeSync } from 'fs-extra';
import glob from 'glob';
import { relative, resolve } from 'path';

interface IPackagrConfig {
  compiledSources: string;
  microservices: { [key: string]: { path: string; packageName: string } };
  packageDirectory?: string;
}

const currentDirectory = resolve('./') + '/';

const listDependencies = (services: string[]): string[] => {
  const directDependencies = execSync(`npm ls --prod=true --parseable=true --long=false --silent || true`)
    .toString('utf-8')
    .split('\n')
    .filter((path) => path.match(/node_modules\/(.+)$/) != null);
  const dependencies: Set<string> = new Set(directDependencies.map((dep) => dep.match(/node_modules\/(.+)$/)[1]));

  const otherServicesDependencies: string[][] = services.map((service) =>
    execSync(`cd ${service} && npm ls --prod=true --parseable=true --long=false --silent || true`)
      .toString('utf-8')
      .split('\n')
      .filter((path) => path.match(/node_modules\/(.+)$/) != null)
      .filter((dep) => !dependencies.has(dep.match(/node_modules\/(.+)$/)[1]))
      .map((dep) => {
        dependencies.add(dep.match(/node_modules\/(.+)$/)[1]);
        return dep;
      }),
  );
  return [...directDependencies, ...otherServicesDependencies.reduce((b1, b2) => b1.concat(b2), [])].map(
    (path) => relative(currentDirectory, path) + '/**',
  );
};

const getRelativeGlobs = (config: IPackagrConfig): string[] => {
  const includes: string[] = [
    config.compiledSources,
    ...listDependencies(Object.keys(config.microservices).map((m) => config.microservices[m].path)),
    ...Object.keys(config.microservices).map((m) => `node_modules/${config.microservices[m].packageName}/lib/src/**/*`),
  ];
  return includes;
};

(() => {
  if (!existsSync('./serverless.yml')) {
    console.error('[Packagr] You are not launching packagr in a serverless project');
    process.exit(1);
  }

  if (!existsSync('./package.json')) {
    console.error('[Packagr] Error: package.json not found');
    process.exit(1);
  }

  try {
    const packageFile = JSON.parse(readFileSync('./package.json').toString('utf-8'));
    console.error('[Packagr] Packaging lambdas source codes for service', packageFile.name);
  } catch (e) {
    console.error('[Packagr] Cannot read package.json', e);
    process.exit(1);
  }

  let config: IPackagrConfig;
  try {
    config = JSON.parse(readFileSync('./packagr.json').toString('utf-8'));
  } catch (e) {
    console.error('[Packagr] Cannot read packagr config file', e);
    process.exit(1);
  }

  if (!config.compiledSources) {
    console.error('[Packagr] Please provide path to your compiled source code');
    process.exit(1);
  }

  if (!config.microservices) {
    console.error('[Packagr] Please provide informations on dependent services');
    process.exit(1);
  }

  const packageDirectory = config.packageDirectory || './.package';

  if (existsSync(packageDirectory)) {
    removeSync(packageDirectory);
  }
  mkdirSync(packageDirectory);
  mkdirSync(packageDirectory + '/node_modules');

  const relativeGlobs = getRelativeGlobs(config);
  const relativeFiles: string[] = relativeGlobs.map((g) => glob.sync(g)).reduce((b1, b2) => b1.concat(b2), []);
  const toZip: Map<string, string> = new Map();

  relativeFiles.forEach((file) => {
    const externalDependency = file.match(/^\.\..+(node_modules\/.+)$/);
    const compiledSource = file.match(/^lib\/(.+)$/);
    if (externalDependency) {
      toZip.set(file, externalDependency[1]);
    } else if (compiledSource) {
      toZip.set(file, compiledSource[1]);
    } else {
      toZip.set(file, file);
    }
  });

  const archive = archiver('zip');
  const output = createWriteStream(currentDirectory + '.package/package.zip');

  output.on('close', () => {
    console.info('[Packagr] Zip file successfully created');
    console.info('[Packagr] ' + archive.pointer() + ' total bytes');
    process.exit(0);
  });

  archive.on('warning', (err) => {
    if (err.code === 'ENOENT') {
      console.warn(err);
    } else {
      console.error(err);
      process.exit(1);
    }
  });

  archive.on('error', (err) => {
    console.error(err);
    process.exit(1);
  });

  archive.pipe(output);
  toZip.forEach((dest, from) =>
    archive.file(from, {
      name: dest,
    }),
  );
  archive.finalize();
})();
