import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';

import async from 'async';
import loaderUtils from 'loader-utils';
import schemaUtils from 'schema-utils';
import sourceMappingURL from 'source-map-url';

import schema from './options.json';

const LOADER_NAME = 'remote-source-map-loader';

export default function loader(content, map, meta) {
  const emitWarning = this.emitWarning || (() => {});
  const options = resolveOptions.call(this);
  if (!this.sourceMap) return content;
  const callback = this.async();
  loadSources.call(this, content, options).then(
    (result) => {
      if (result.content && map) {
        emitWarning(
          new Error(
            `A previous loader already produced a source map for ${this.resourcePath}. It will be overwritten.`
          )
        );
      }
      callback(null, result.content, result.map || map, meta);
    },
    (err) => {
      callback(err);
    }
  );
  return undefined;
}

function resolveOptions() {
  const options = loaderUtils.getOptions(this) || {};
  schemaUtils.validate(schema, options, { name: LOADER_NAME });
  const sourceDir = options.sourceDir || 'src';
  const defaultPFT = defaultPostFetchTransform(sourceDir);
  const postFetchTransform = options.postFetchTransform
    ? (sourcePath) => options.postFetchTransform(sourcePath, defaultPFT)
    : defaultPostFetchTransform;
  return {
    exclude: filterFunctions(options.exclude, () => false),
    cacheDir:
      options.cacheDirectory === undefined
        ? `.${LOADER_NAME}`
        : options.cacheDirectory,
    preFetchTransform: options.preFetchTransform || ((i) => i),
    sourceDir,
    postFetchTransform,
    includeContent: filterFunction(options.includeContent, () => true),
    emitContent: filterFunction(options.emitContent, () => true),
  };
}

async function loadSources(content, options) {
  const { addDependency, context } = this;
  const emitWarning = this.emitWarning || (() => {});
  const sourceMapURL = sourceMappingURL.getFrom(content);
  if (!sourceMapURL) return { content };
  if (!loaderUtils.isUrlRequest(sourceMapURL)) {
    emitWarning(
      new Error(`Source map URL '${sourceMapURL}' is not requestable.`)
    );
  }
  const sourceMapRequest = loaderUtils.urlToRequest(sourceMapURL);
  const sourceMapPath = await asyncResolve.call(
    this,
    context,
    sourceMapRequest
  );
  addDependency(sourceMapPath);
  const sourceMapContent = await fs.promises.readFile(sourceMapPath, 'utf-8');
  const sourceMap = JSON.parse(sourceMapContent);
  const sourceRoot = path.join(
    path.dirname(sourceMapPath),
    sourceMap.sourceRoot || ''
  );
  const contentWithoutSourceMappingURL = sourceMappingURL.removeFrom(content);
  const newSources = await fetchSources.call(
    this,
    sourceMap.sources,
    sourceMap.sourcesContent,
    sourceRoot,
    options
  );
  sourceMap.sources = newSources.reduce((acc, next) => {
    acc.push(next.source);
    return acc;
  }, []);
  sourceMap.sourcesContent = newSources.reduce((acc, next) => {
    acc.push(next.sourceContent || null);
    return acc;
  }, []);
  return { content: contentWithoutSourceMappingURL, map: sourceMap };
}

// Returns: Promise[Array[{source: string, sourceContent?: string}]]
async function fetchSources(sources, sourcesContent, sourceRoot, options) {
  const sourcesWithIndex = sources.map((source, index) => {
    return { source, index };
  });
  return async.map(sourcesWithIndex, async (sourceWithIndex) => {
    const { source, index } = sourceWithIndex;
    if (options.exclude.some((f) => f(source))) return { source };
    const transformedSource = options.preFetchTransform(source);
    if (!transformedSource) return { source };
    const sourceContent = sourcesContent ? sourcesContent[index] : null;
    return fetchSource.call(
      this,
      transformedSource,
      sourceContent,
      sourceRoot,
      options
    );
  });
}

// TODO: What should we have a dependency on?
// Returns: Promise[{source: string, sourceContent?: string}]
async function fetchSource(source, sourceContent, sourceRoot, options) {
  const emitWarning = this.emitWarning || (() => {});
  const emitFile = this.emitFile || (() => {});
  const includeContent = options.includeContent(source);
  const emitContent = options.emitContent(source);
  if (!includeContent && !emitContent) {
    return { source, sourceContent };
  }
  const sourceURL = tryOrNull(() => new URL(source));
  if (!sourceContent) {
    if (sourceURL) {
      const cachePath = getCachePath(sourceURL, options);
      const readFromCache = await canReadFromCache(cachePath);
      if (readFromCache) {
        sourceContent = await fs.promises.readFile(cachePath);
      } else {
        sourceContent = await fetchRemote.call(this, sourceURL);
        if (cachePath) {
          await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
          await fs.promises.writeFile(cachePath, sourceContent);
        }
      }
    } else {
      sourceContent = await fetchLocal.call(this, source, sourceRoot);
    }
  }
  const relativeSource = path.relative(
    this.rootContext,
    path.join(sourceRoot, source)
  );
  const name = options.postFetchTransform(sourceURL || relativeSource);
  if (emitContent) {
    if (!sourceContent) {
      emitWarning(
        new Error(`Source content was empty for ${source} in ${sourceRoot}.`)
      );
    } else {
      // TODO: Do we need to include asset info (like immutable)?
      emitFile(name, sourceContent);
    }
  }
  if (includeContent) {
    return { source: name, sourceContent };
  } 
    return { source: name, sourceContent: null };
  
}

function getCachePath(sourceURL, options) {
  if (options.cacheDir) {
    return path.join(options.cacheDir, sourceURL.hostname + sourceURL.pathname);
  } 
    return null;
  
}

async function canReadFromCache(cachePath) {
  if (cachePath) {
    try {
      await fs.promises.access(cachePath);
      return true;
    } catch (e) {
      // Do nothing.
    }
  }
  return false;
}

// Returns: Promise[string]
function fetchRemote(sourceURL) {
  const emitWarning = this.emitWarning || (() => {});
  switch (sourceURL.protocol) {
    case 'http:':
      emitWarning(
        new Error(`Insecure HTTP protocol used for source '${sourceURL}'.`)
      );
      return downloadHttpSource.call(this, http, sourceURL);
    case 'https:':
      return downloadHttpSource.call(this, https, sourceURL);
    default:
      emitWarning(new Error(`Unsupported protocol '${sourceURL.protocol}'.`));
      return null;
  }
}

// Returns: Promise[string]
async function downloadHttpSource(module, sourceURL) {
  return new Promise((resolve, reject) => {
    module.get(sourceURL, (message) => {
      managedStream(message, (message) => {
        readableToString(message).then(resolve, reject);
      });
    });
  });
}

// Returns: Promise[string]
async function fetchLocal(source, sourceRoot) {
  const emitWarning = this.emitWarning || (() => {});
  try {
    const sourcePath = await asyncResolve.call(this, sourceRoot, source);
    return await fs.promises.readFile(sourcePath, { encoding: 'utf8' });
  } catch (e) {
    emitWarning(e);
    return null;
  }
}

function defaultPostFetchTransform(sourceDir) {
  return (sourcePath) => {
    if (typeof sourcePath === 'string') {
      const parts = path.parse(path.normalize(sourcePath));
      const noRoot = path.join(parts.dir, parts.base);
      const relativeToAncestor = noRoot
        .split(path.sep)
        .filter((p) => p !== '..')
        .join(path.sep);
      return sourceDir
        ? path.join(sourceDir, relativeToAncestor)
        : relativeToAncestor;
    } 
      const remotePath = path.join(sourcePath.hostname, sourcePath.pathname);
      return sourceDir ? path.join(sourceDir, remotePath) : remotePath;
    
  };
}

function filterFunctions(option, defaultValue) {
  if (Array.isArray(option)) {
    return option.map((a) => filterFunction(a, defaultValue));
  } 
    return [filterFunction(option, defaultValue)];
  
}

function filterFunction(option, defaultValue) {
  if (typeof option === 'function') {
    return option;
  } else if (typeof option === 'boolean') {
    return () => option;
  } else if (typeof option === 'string') {
    return (input) => input === option;
  } else if (option instanceof RegExp) {
    const regex = new RegExp(option);
    return (input) => regex.test(input);
  } 
    return defaultValue;
  
}

function tryOrNull(f, e) {
  try {
    return f();
  } catch (err) {
    if (e) e(err);
    return null;
  }
}

function managedStream(stream, f) {
  try {
    return f(stream);
  } catch (e) {
    // This will be a no-op if it is already destroyed.
    stream.destroy(e);
    throw e;
  }
}

// This only handles UTF-8.
function readableToString(readable) {
  return new Promise((resolve, reject) => {
    let str = '';
    readable.setEncoding('utf8');
    readable.on('data', (chunk) => {
      str += chunk;
    });
    readable.on('end', () => {
      resolve(str);
    });
    readable.on('error', (err) => {
      reject(err);
    });
  });
}

function asyncResolve(content, request) {
  const webpackResolve = this.resolve;
  return new Promise((resolve, reject) => {
    webpackResolve(content, request, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}
