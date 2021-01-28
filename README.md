# webpack-remote-source-map-loader

A Webpack loader that can locate source maps from their `sourceMappingURL` and fetches remote sources.

This is similar to [source-map-loader] but it has a few additional benefits:

- Download remote sources (like what [scalajs-friendly-source-map-loader] does for [Scala.js]).
- Excluding individual sources.
- Fixing invalid source paths.
- Emitting the source content to a file.

## Getting Started

Install:

```shell
npm install --save-dev remote-source-map-loader
```

Add a rule to your `webpack.config.js`:

```javascript
module.exports = {
  module: {
    rules: [
      {
        test: /\.js$/,
        enforce: 'pre',
        use: 'remote-source-map-loader',
      },
    ],
  },
};
```

## Options

### exclude

Type: `String|RegExp|Function` (can be repeated in an array)
Default: `() => false`

A filter used to exclude sources from being processed. They will still appear in the resulting source map in order to
keep the `mappings` intact.

The `String` form is equivalent to `source => source === value`.

The `Regex` form is equivalent to `source => new RegExp(value).test(source)`.

For the `Function` form it should be of the type `(source: string) => boolean`. `source` is the value from the
`sources` array in the source map. The returned value should be something that is truthy/falsey.

#### Example

```javascript
module.exports = {
  module: {
    rules: [
      {
        test: /\.js$/,
        enforce: 'pre',
        use: {
          loader: 'remote-source-map-loader',
          options: {
            exclude: [
              'virtualfile:%3Cmacro%3E',
              / \[synthetic:.*\] /,
              (source) =>
                source.startsWith('temp/node_modules/google-closure-library'),
            ],
          },
        },
      },
    ],
  },
};
```

### cacheDirectory

Type: `String`
Default: `.remote-source-map-loader`

Path to a directory to use for caching remote files.

Any remote files will be fetched and written to this directory. On subsequent executions, if the file exists in this
directory then it will be read from there.

To disable caching set this to `null` or `false`.

#### Example

```javascript
module.exports = {
  module: {
    rules: [
      {
        test: /\.js$/,
        enforce: 'pre',
        use: {
          loader: 'remote-source-map-loader',
          options: {
            cacheDirectory: 'cache',
          },
        },
      },
    ],
  },
};
```

### preFetchTransform

Type: `Function`
Default: `source => source`

A transformation to apply to each source before it is fetched.

The transformed source value will be used for the remainder of the loader including fetching, other transformations and
filters, and in the resulting source map.

The `Function` should be of the type `(source: string) => string`. `source` is the value from the `sources` array in the
source map. The returned value should be a valid URL or file path.

A common use for this is to correct incorrect source maps.

#### Example

```javascript
module.exports = {
  module: {
    rules: [
      {
        test: /\.js$/,
        enforce: 'pre',
        use: {
          loader: 'remote-source-map-loader',
          preFetchTransform: (source) => {
            return source
              .replace(
                '../../../../../../../../lihaoyi/Github/sourcecode',
                'https://raw.githubusercontent.com/lihaoyi/sourcecode/0.2.1'
              )
              .replace(
                '../../../streams/_global/stImport/_global/streams/sources',
                'https://raw.githubusercontent.com/ScalablyTyped/Distribution/master'
              );
          },
        },
      },
    ],
  },
};
```

### postFetchTransform

Type: `Function`
Default:

```javascript
(sourcePath) => {
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
  } else {
    const remotePath = path.join(sourcePath.hostname, sourcePath.pathname);
    return sourceDir ? path.join(sourceDir, remotePath) : remotePath;
  }
};
```

A transformation to apply to each source after it is fetched.

The transformed source will be used to emit the file and/or use in the resulting `sources` (if applicable).

The `Function` should be of the type `(source: string|URL, defaultTransform: (source: string) => string) => string`.
`source` is the value from `preFetchTransform`. `defaultTransform` is the default transform which you can use to chain
with your function.

The returned value should be a valid URL or file path.

A common use for this is to modify where the source is emitted to.

#### Example

```javascript
module.exports = {
  module: {
    rules: [
      {
        test: /\.js$/,
        enforce: 'pre',
        use: {
          loader: 'remote-source-map-loader',
          postFetchTransform: (source, defaultTransform) => {
            return defaultTransform(source).replace(/^node_modules/, 'libs');
          },
        },
      },
    ],
  },
};
```

### includeContent

Type: `Boolean|Function`
Default: `() => true`

Determines whether to include the source content in the source map.

The `Boolean` form is equivalent to `() => value`.

For the `Function` form it should be of the type `(source: string) => boolean`.
`source` is the value from `preFetchTransform`. The returned value should be something that is truthy/falsey.

This has the same effect as setting `noSources: true` in the `SourceMapDevToolPlugin` but is done before the plugin, and
it gives you the ability to control it independently for each source.

#### Example

```javascript
module.exports = {
  module: {
    rules: [
      {
        test: /\.js$/,
        enforce: 'pre',
        use: {
          loader: 'remote-source-map-loader',
          includeContent: false,
        },
      },
    ],
  },
};
```

### emitContent

Type: `Boolean|Function`
Default: `() => true`

Determines whether to emit the source content to a separate file.

The `Boolean` form is equivalent to `() => value`.

For the `Function` form it should be of the type `(source: string) => boolean`.
`source` is the value from `preFetchTransform`. The returned value should be something that is truthy/falsey.

This is something that is currently not possible with the `SourceMapDevToolPlugin`.

The common use case for this is to separate your sources from your source map file for better control, especially when
deploying to production.

#### Example

```javascript
module.exports = {
  module: {
    rules: [
      {
        test: /\.js$/,
        enforce: 'pre',
        use: {
          loader: 'remote-source-map-loader',
          emitContent: false,
        },
      },
    ],
  },
};
```

### sourceDir

Type: `String`
Default: `'src'`

Path to use as the base directory for the default [postFetchTransform](#postfetchtransform) function.

#### Example

```javascript
module.exports = {
  module: {
    rules: [
      {
        test: /\.js$/,
        enforce: 'pre',
        use: {
          loader: 'remote-source-map-loader',
          sourceDir: 'private',
        },
      },
    ],
  },
};
```

[scala.js]: https://www.scala-js.org/
[scalajs-friendly-source-map-loader]: https://www.npmjs.com/package/scalajs-friendly-source-map-loader
[source-map-loader]: https://github.com/webpack-contrib/source-map-loader
