import fs from 'fs';
import _ from 'lodash';
import vm from 'vm';
import chokidar from 'chokidar';
import path from 'path';
import globby from 'globby';
import chalk from 'chalk';
import chunkSorter from './lib/chunksorter.js';
import childCompiler from './lib/compiler.js';
import prettyError from './lib/errors.js';

function info(object) {
  console.log(chalk.bgBlue.white(object));
}

function danger(object) {
  console.log(chalk.bgRed.white(object));
}

class WebpackHtmlWatchPlugin {

  constructor(options) {
    this.options = _.extend({
      basePath: path.join(__dirname, '../../../'),
      templates: [path.join(__dirname, '../../../src/views/**/*.html')],
      templatesPath: path.join(__dirname, '../../../src/templates/'),
      templateEngineOptions: {},
      templateContext: {},
      templateNamer: path => path,
      watch: true,
      reloadBrowser: true,
      hash: false,
      chunks: 'all',
      excludeChunks: [],
      chunksSortMode: undefined
    }, options);

    info(this.options.templates);

    this.watcher = chokidar.watch(this.options.templates, {
      ignoreInitial: true
    });

    this.watcher
      .on('add', path => {
        this.watchQueue.set.push(path);
        this.compiler.run(function(){
          info(`Add new file ${path}`)
        });
      })
      .on('change', path => {
        this.watchQueue.set.push(path);
        this.compiler.run(function(){
          info(`Change file ${path}`)
        });
      })
      .on('unlink', path => {
        this.watchQueue.unlink.push(path);
        info(`Unlink file ${path}`)
      })

    this.watchQueue = {
      set: globby.sync(this.options.templates),
      unlink: []
    }

    this.compiledTemplates = [];
    this.templateSources = [];
    this.fileDependencies = [];
  }


  apply(compiler) {
    this.compiler = compiler;

    compiler.plugin('make', (compilation, callback) => {
      let compilationPromises = []

      this.watchQueue.set.forEach((path) => {
        let relativeTemplatePath = this.getRelativeTemplatePath(path);
        let compilerPath = require.resolve('./lib/loader.js') + '!' + path;
        let outputPath = this.options.templateNamer(relativeTemplatePath);
        let compilationPromise = childCompiler.compileTemplate(compilerPath, '', outputPath, compilation);

        compilationPromise.catch(err => danger(err));
        compilationPromises.push(compilationPromise);
      });

      this.watchQueue.set = [];

      this.watchQueue.unlink.forEach((path) => {
        this.unlinkAsset(compilation, path);
      });

      Promise.all(compilationPromises)
        .then((compiledTemplates) => {
          this.compiledTemplates = compiledTemplates;
          callback();
        });
    });


    compiler.plugin('emit', (compilation, callback) => {
      let evaluatePromises = []
      let chunks = compilation.getStats().toJson().chunks;
          chunks = this.filterChunks(chunks, this.options.chunks, this.options.excludeChunks);
          chunks = this.sortChunks(chunks, this.options.chunksSortMode);
      let assets = this.htmlWebpackPluginAssets(compilation, chunks);

      this.compiledTemplates.forEach((compiledTemplate) => {
        let evaluatePromise = this.evaluateCompilationResult(
          compilation,
          compiledTemplate.content,
          compiledTemplate.outputName
        ).then((source) => {
          // Remove the filename of the template
          let assetTags = this.generateAssetTags(assets, compiledTemplate.outputName);
          source = this.injectAssetsIntoHtml(source, assets, assetTags);
          this.setAsset(compilation, compiledTemplate.outputName, source);

          return source;
        });

        evaluatePromises.push(evaluatePromise);
      })

      Promise.all(evaluatePromises).then((sources) => {
        callback();
      });
    });
  }














  setAsset(compilation, path, content) {
    compilation.assets[path] = {
      source: function() { return content },
      size: function() { return new Buffer(content).byteLength }
    }

    this.fileDependencies.push(path);
  }

  unlinkAsset(compilation, path) {
    delete compilation.assets[path];
  }

  pluginAssets (compilation, chunks) {
    var self = this;
    var compilationHash = compilation.hash;

    var assets = {
      // publicPath: this.options.publicPath,
      chunks: {},
      js: [],
      css: [],
      manifest: Object.keys(compilation.assets).filter(function (asset) {
        return path.extname(asset) === '.appcache';
      })[0]
    };

    if (this.options.hash) {
      assets.manifest = this.appendHash(assets.manifest, compilationHash);
      assets.favicon = this.appendHash(assets.favicon, compilationHash);
    }

    for (var i = 0; i < chunks.length; i++) {
      var chunk = chunks[i];
      var chunkName = chunk.names[0];

      assets.chunks[chunkName] = {};
      if (this.options.hash) {
        chunkFiles = chunkFiles.map((chunkFile) => {
          return this.appendHash(chunkFile, compilationHash);
        });
      }

      // Webpack outputs an array for each chunk when using sourcemaps. But we
      // need only the entry file
      var entry = chunkFiles[0];
      assets.chunks[chunkName].size = chunk.size;
      assets.chunks[chunkName].entry = entry;
      assets.chunks[chunkName].hash = chunk.hash;
      assets.js.push(entry);

      // Gather all css files with only their file name no extra hash or query
      var css = chunkFiles.filter(function (chunkFile) {
        return /.css($|\?)/.test(chunkFile);
      });

      assets.chunks[chunkName].css = css;
      assets.css = assets.css.concat(css);
    }

    // Duplicate css assets can occur on occasion if more than one chunk
    // requires the same css.
    assets.css = _.uniq(assets.css);

    return assets;
  };

  getAssetFiles (assets) {
    var files = _.uniq(Object.keys(assets).filter(function (assetType) {
      return assetType !== 'chunks' && assets[assetType];
    }).reduce(function (files, assetType) {
      return files.concat(assets[assetType]);
    }, []));
    files.sort();

    return files;
  };

  appendHash (url, hash) {
    if (!url) {
      return url;
    }

    return url + (url.indexOf('?') === -1 ? '?' : '&') + hash;
  };

  createHtmlTag(tagDefinition) {
    var attributes = Object.keys(tagDefinition.attributes || {})
      .filter(function (attributeName) {
        return tagDefinition.attributes[attributeName] !== false;
      })
      .map(function (attributeName) {
        if (tagDefinition.attributes[attributeName] === true) {
          return attributeName;
        }
        return attributeName + '="' + tagDefinition.attributes[attributeName] + '"';
      });
    // Backport of 3.x void tag definition
    var voidTag = tagDefinition.voidTag !== undefined ? tagDefinition.voidTag : !tagDefinition.closeTag;
    var selfClosingTag = tagDefinition.voidTag !== undefined ? tagDefinition.voidTag && this.options.xhtml : tagDefinition.selfClosingTag;
    return '<' + [tagDefinition.tagName].concat(attributes).join(' ') + (selfClosingTag ? '/' : '') + '>' +
      (tagDefinition.innerHTML || '') +
      (voidTag ? '' : '</' + tagDefinition.tagName + '>');
  };

  generateAssetTags(assets, outputName) {
    let templatePath = path.dirname(outputName)

    var scripts = assets.js.map(function (scriptPath) {
      return {
        tagName: 'script',
        closeTag: true,
        attributes: {
          type: 'text/javascript',
          src: path.relative(templatePath, scriptPath)
        }
      };
    });

    var selfClosingTag = false;
    // Turn css files into link tags
    var styles = assets.css.map(function (stylePath) {
      return {
        tagName: 'link',
        selfClosingTag: selfClosingTag,
        attributes: {
          href: path.relative(templatePath, scriptPath),
          rel: 'stylesheet'
        }
      };
    });
    // Injection targets
    var head = [];
    var body = [];

    // If there is a favicon present, add it to the head
    if (assets.favicon) {
      head.push({
        tagName: 'link',
        selfClosingTag: selfClosingTag,
        attributes: {
          rel: 'shortcut icon',
          href: path.relative(templatePath, assets.favicon)
        }
      });
    }
    // Add styles to the head
    head = head.concat(styles);
    // Add scripts to body or head
    if (this.options.inject === 'head') {
      head = head.concat(scripts);
    } else {
      body = body.concat(scripts);
    }
    return {head: head, body: body};
  };

  injectAssetsIntoHtml(html, assets, assetTags) {
    var htmlRegExp = /(<html[^>]*>)/i;
    var headRegExp = /(<\/head\s*>)/i;
    var bodyRegExp = /(<\/body\s*>)/i;
    var body = assetTags.body.map(this.createHtmlTag);
    var head = assetTags.head.map(this.createHtmlTag);

    if (body.length) {
      if (bodyRegExp.test(html)) {
        // Append assets to body element
        html = html.replace(bodyRegExp, function (match) {
          return body.join('') + match;
        });
      } else {
        // Append scripts to the end of the file if no <body> element exists:
        html += body.join('');
      }
    }

    if (head.length) {
      if (!headRegExp.test(html)) {
        if (!htmlRegExp.test(html)) {
          html = '<head></head>' + html;
        } else {
          html = html.replace(htmlRegExp, function (match) {
            return match + '<head></head>';
          });
        }
      }

      html = html.replace(headRegExp, function (match) {
        return head.join('') + match;
      });
    }

    if (assets.manifest) {
      html = html.replace(/(<html[^>]*)(>)/i, function (match, start, end) {
        if (/\smanifest\s*=/.test(match)) {
          return match;
        }
        return start + ' manifest="' + assets.manifest + '"' + end;
      });
    }

    return html;
  };

  sortChunks(chunks, sortMode) {
    // Sort mode auto by default:
    if (typeof sortMode === 'undefined') {
      sortMode = 'auto';
    }
    // Custom function
    if (typeof sortMode === 'function') {
      return chunks.sort(sortMode);
    }
    // Disabled sorting:
    if (sortMode === 'none') {
      return chunkSorter.none(chunks);
    }
    // Check if the given sort mode is a valid chunkSorter sort mode
    if (typeof chunkSorter[sortMode] !== 'undefined') {
      return chunkSorter[sortMode](chunks, this.options.chunks);
    }
    throw new Error('"' + sortMode + '" is not a valid chunk sort mode');
  };

  filterChunks(chunks, includedChunks, excludedChunks) {
    return chunks.filter(function (chunk) {
      var chunkName = chunk.names[0];
      // This chunk doesn't have a name. This script can't handled it.
      if (chunkName === undefined) {
        return false;
      }
      // Skip if the chunk should be lazy loaded
      if (typeof chunk.isInitial === 'function') {
        if (!chunk.isInitial()) {
          return false;
        }
      } else if (!chunk.initial) {
        return false;
      }
      // Skip if the chunks should be filtered and the given chunk was not added explicity
      if (Array.isArray(includedChunks) && includedChunks.indexOf(chunkName) === -1) {
        return false;
      }
      // Skip if the chunks should be filtered and the given chunk was excluded explicity
      if (Array.isArray(excludedChunks) && excludedChunks.indexOf(chunkName) !== -1) {
        return false;
      }
      // Add otherwise
      return true;
    });
  };

  getRelativeTemplatePath(path) {
    return path.replace(this.options.templatesPath, '');
  }

  getFullTemplatePath(template, context) {
    if (template.indexOf('!') === -1) {
      template = require.resolve('./lib/loader.js') + '!' + path.resolve(context, template);
    }

    return template.replace(
      /([!])([^/\\][^!?]+|[^/\\!?])($|\?[^!?\n]+$)/,
      function (match, prefix, filepath, postfix) {
        return prefix + path.resolve(filepath) + postfix;
      }
    );
  };

  htmlWebpackPluginAssets(compilation, chunks) {
    var self = this;
    let compilationHash = compilation.hash;
    let publicPath = compilation.options.output.path;

    // if (publicPath.length && publicPath.substr(-1, 1) !== '/') {
    //   publicPath += '/';
    // }

    let assets = {
      // publicPath: publicPath,
      chunks: {},
      js: [],
      css: [],
      manifest: Object.keys(compilation.assets).filter(function (assetFile) {
        return path.extname(assetFile) === '.appcache';
      })[0]
    };

    if (this.options.hash) {
      assets.manifest = self.appendHash(assets.manifest, compilationHash);
      assets.favicon = self.appendHash(assets.favicon, compilationHash);
    }

    for (var i = 0; i < chunks.length; i++) {
      var chunk = chunks[i];
      var chunkName = chunk.names[0];

      assets.chunks[chunkName] = {};

      // Prepend the public path to all chunk files
      var chunkFiles = [].concat(chunk.files).map(function (chunkFile) {
        return chunkFile;
        return publicPath + chunkFile;
      });

      // Append a hash for cache busting
      if (this.options.hash) {
        chunkFiles = chunkFiles.map(function (chunkFile) {
          return self.appendHash(chunkFile, compilationHash);
        });
      }

      // Webpack outputs an array for each chunk when using sourcemaps
      // But we need only the entry file
      var entry = chunkFiles[0];
      assets.chunks[chunkName].size = chunk.size;
      assets.chunks[chunkName].entry = entry;
      assets.chunks[chunkName].hash = chunk.hash;
      assets.js.push(entry);

      // Gather all css files
      var css = chunkFiles.filter(function (chunkFile) {
        // Some chunks may contain content hash in their names, for ex. 'main.css?1e7cac4e4d8b52fd5ccd2541146ef03f'.
        // We must proper handle such cases, so we use regexp testing here
        return /.css($|\?)/.test(chunkFile);
      });
      assets.chunks[chunkName].css = css;
      assets.css = assets.css.concat(css);
    }

    // Duplicate css assets can occur on occasion if more than one chunk
    // requires the same css.
    assets.css = _.uniq(assets.css);

    return assets;
  };

  isHotUpdateCompilation(assets) {
    return assets.js.length && assets.js.every(function (name) {
      return /\.hot-update\.js$/.test(name);
    });
  };

  evaluateCompilationResult(compilation, source, template) {

    if (!source) {
      return Promise.reject('The child compilation didn\'t provide a result');
    }

    // The LibraryTemplatePlugin stores the template result in a local variable.
    // To extract the result during the evaluation this part has to be removed.
    source = source.replace('var HTML_WEBPACK_PLUGIN_RESULT =', '');
    template = template.replace(/^.+!/, '').replace(/\?.+$/, '');
    let vmContext = vm.createContext(_.extend({HTML_WEBPACK_PLUGIN: true, require: require}, global));
    let vmScript = new vm.Script(source, {filename: template});
    let newSource;

    try {
      newSource = vmScript.runInContext(vmContext);
    } catch (e) {
      return Promise.reject(e);
    }

    if (typeof newSource === 'object' && newSource.__esModule && newSource.default) {
      newSource = newSource.default;
    }

    return typeof newSource === 'string' || typeof newSource === 'function'
      ? Promise.resolve(newSource)
      : Promise.reject('The loader "' + template + '" didn\'t return html.');
  };
}

export default WebpackHtmlWatchPlugin;
