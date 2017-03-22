'use strict';

var xfs = require('xfs');
var path = require('path');
var async = require('async');
var utils = require('./lib/utils');

/**
 * 处理整个Dir的编译
 * @param {Cube} cube instance
 * @param {Object} options 参数
 *                    - src
 *                    - dest
 */
function processDir(cube, options, cb) {
  let source = options.src;
  let dest = options.dest;
  if (!dest) {
    return console.log('[ERROR] param missing! dest');
  }
  if (!cb) {
    cb = function () {};
  }
  var st = new Date().getTime();
  var fileCount = 0;
  var errors = [];
  var root = cube.config.root;

  // analyseNoduleModules(path.join(source, 'node_modules'), nodeModulesMap, function () {
  xfs.walk(source, function (err, sourceFile, done) {
    if (err) {
      return done(err);
    }
    fileCount++;

    var relFile = utils.fixWinPath(sourceFile.substr(root.length));
    var destFile = path.join(dest, relFile);
    var checked = cube.checkIgnore(relFile);

    if (checked.ignore) {
      console.log('[ignore file]:', relFile.substr(1));
      return done();
    } else if (checked.skip) {
      xfs.sync().save(destFile, xfs.readFileSync(sourceFile));
      console.log('[copy file]:', relFile.substr(1));
      return done();
    }

    try {
      processFile(cube, {
        src: sourceFile,
        dest: dest
      }, function (err) {
        if (err) {
          if (typeof err == 'string') err = new Error(err);
          if (!err.file) err.file = sourceFile;
          errors.push(err);
        }
        done();
      });
    } catch (e) {
      if (/node_modules/.test(sourceFile)) {
        // should ignore the error
        e.file = sourceFile;
        errors.push(e);
      } else {
        throw e;
      }
      done();
    }
  }, function () {
    xfs.writeFileSync(
      path.join(dest, 'cube.js'),
      xfs.readFileSync(path.join(__dirname, './runtime/cube.min.js'))
    );
    var end = new Date().getTime();
    cb(errors, {
      total: fileCount,
      time: Math.ceil((end - st) / 1000)
    });
  });
  // });
}


/**
 * 选择性编译
 *   1. 当前目录下，除了node_modules目录，其他文件都编译
 *   2. node_modules目录，选择性编译
 * @param  {Cube}   cube
 * @param  {Object}   data
 *         - src
 *         - dest
 *         - withSource
 * @param  {Function} cb()
 */

function processDirSmart(cube, data, cb) {
  var source = data.src;
  var dest = data.dest;
  var st = new Date();
  if (!dest) {
    return console.log('[ERROR] param missing! dest');
  }
  if (!cb) {
    cb = function () {};
  }
  var errors = [];
  var root = cube.config.root;
  var requiredModuleFile = {}; // 依赖的node_modules文件
  var files = [];

  // let st = new Date().getTime();

  console.time('process app file');

  // analyseNoduleModules(path.join(source, 'node_modules'), nodeModulesMap, function () {
  xfs.walk(source, function check(p) {
    var relFile = utils.fixWinPath(p.substr(root.length));
    if (/^\/node_modules\//.test(relFile)) {
      return false;
    }
    return true;
  }, function (err, sourceFile, done) {
    if (err) {
      return done(err);
    }

    var relFile = utils.fixWinPath(sourceFile.substr(root.length));
    var destFile = path.join(dest, relFile);
    var checked = cube.checkIgnore(relFile);

    if (checked.ignore) {
      console.log('[ignore file]:', relFile.substr(1));
      return done();
    } else if (checked.skip) {
      xfs.sync().save(destFile, xfs.readFileSync(sourceFile));
      console.log('[copy file]:', relFile.substr(1));
      return done();
    }

    try {
      processFile(cube, {
        src: sourceFile
      }, function (err, res) {
        if (err) {
          if (err === 'unknow_type') {
            xfs.sync().save(destFile, xfs.readFileSync(sourceFile));
            console.log('[copy file]:', relFile.substr(1));
            return done();
          } else if (!err.file) {
            err.file = sourceFile;
          }
          errors.push(err);
        }
        var originRequire;
        if (res && res.data) {
          if (res.data.type === 'style') {
            xfs.sync().save(destFile.replace(/\.\w+$/, '.css'), res.data.code);
          }
          files.push(res.data);
          originRequire = res.data.requiresOrigin;
          originRequire && originRequire.forEach(function (v) {
            if (/^\/node_modules/.test(v)) {
              requiredModuleFile[v] = true;
            }
          });
        }
        done();
      });
    } catch (e) {
      if (/node_modules/.test(sourceFile)) {
        // should ignore the error
        e.file = sourceFile;
        errors.push(e);
      } else {
        throw e;
      }
      done();
    }
  }, function () {
    console.timeEnd('process app file');
    let requireModules = Object.keys(requiredModuleFile);
    console.time('process node_modules file');
    processRequireModules(cube, requireModules, function (err, modFiles) {
      console.timeEnd('process node_modules file');
      files = files.concat(modFiles);
      processMerge(files);
      let actions = [];
      files.forEach(function (tmp) {
        actions.push(function (done) {
          let targetPath = path.join(dest, tmp.queryPath.replace(/^\w+:/, ''));
          console.log('> gen code:', targetPath);
          xfs.sync().save(targetPath, tmp.codeWraped);
          done();
        });
      });

      async.waterfall(actions, function (err) {
        xfs.writeFileSync(
          path.join(dest, 'cube.js'),
          xfs.readFileSync(path.join(__dirname, './runtime/cube.min.js'))
        );
        console.log('file total', files.length);
        console.log('done', err ? err : 'success');
        let end = new Date();
        cb(errors, {
          total: files.length,
          time: Math.ceil((end - st) / 1000)
        });
      });
    });
  });
}

/**
 * 处理依赖的node_modules中的文件，传入是个文件列表
 * @param  {Cube}   cube     [description]
 * @param  {Array}   arr     文件路径列表， 相对于root
 * @param  {Function} callback [description]
 * @return {[type]}            [description]
 */
function processRequireModules(cube, arr, callback) {
  var res = [];
  var cached = {};
  if (!arr || !arr.length) {
    return callback(null, res);
  }
  var root = cube.config.root;
  async.eachLimit(arr, 10, function (file, done) {
    if (cached[file]) {
      done();
    }
    cached[file] = true;
    var sourceFile = path.join(root, file);
    processFileWithRequires(cube, {
      src: sourceFile,
      cached: cached
    }, function (err, data) {
      res = res.concat(data);
      done();
    });
  }, function (err) {
    callback(err, res);
  });
}
/**
 * 处理文件并且递归其依赖关系合并以来
 * @param  {[type]}   cube [description]
 * @param  {[type]}   data
 *                       - src
 *                       - cached 缓存标记，记录某模块是否已经被build过
 * @param  {Function} cb   [description]
 * @return {[type]}        [description]
 */
function processFileWithRequires(cube, data, callback) {
  var root = cube.config.root;
  var count = 1;
  var files = [];
  var cached = data.cached || {};
  function _cb(err, res) {
    if (err) {
      if (!Array.isArray(err)) {
        err = [err];
      }
      err.forEach(function (e) {
        console.log(e);
      });
      return ;
    }
    var result = res.data;
    files.push(result);
    count --;
    if (result.requiresOrigin) {
      result.requiresOrigin.forEach(function (m) {
        if (cached[m]) {
          return;
        }
        cached[m] = true;
        count ++;
        processFile(cube, {
          src: path.join(root, m)
        }, function (err, data) {
          process.nextTick(function () {
            _cb(err, data);
          });
        });
      });
    }
    if (count === 0) {
      callback(null, files);
    }
  }
  processFile(cube, data, function (err, res) {
    _cb(err, res);
  });
}

/**
 * 合并文件
 * @param  {Array} files         处理完的文件列表
 * @param  {Array} exportModules 人肉设定的root文件
 * @return {[type]}               [description]
 */
function processMerge(files, exportModules) {
  /**
   * root文件Map
   * @type {Object}
   */
  let rootMap = {};
  /**
   * 文件名Map
   */
  let fileMap = {};
  /**
   * 被依赖Map
   */
  let requiredMap = {};
  console.log('prepare files');
  files.forEach(function (file) {
    let reqs = file.requires;
    let qpath = file.queryPath;
    if (!qpath) {
      console.log(file);
    }
    if (!requiredMap[qpath]) {
      requiredMap[qpath] = {};
    }
    fileMap[qpath] = file;
    if (reqs && reqs.length) {
      reqs.forEach(function (req) {
        if (/^\w+:/.test(req)) {
          // remote require, ignore
          return;
        }
        if (!requiredMap[req]) {
          requiredMap[req] = {};
        }
        requiredMap[req][qpath] = true;
      });
    }
  });
  /** 标记root  */
  function markRoot(list, root) {
    let sub = [];
    list.forEach(function (modName) {
      let mod = fileMap[modName];
      // 模块不存在，则忽略
      if (!mod) {
        return;
      }
      // 还没初始化，则初始化
      if (!mod.__roots) {
        mod.__roots = {};
      }
      // 已经标记过该root， 则返回， 解循环依赖的问题
      if (mod.__roots[root]) {
        return;
      }
      // 标记该root
      mod.__roots[root] = true;
      /*
      if (Object.keys(mod.__roots).length > 1) {
        return;
      }
      */
      let reqs = mod.requires;
      if (reqs) {
        sub = sub.concat(reqs);
      }
    });
    // 返回下一层模块
    return sub;
  }
  // 去重
  function unique(arr) {
    arr.forEach(function (f) {
      rootMap[f] = true;
    });
    return Object.keys(rootMap);
  }

  // 合并文件
  function mergeFile(list, nodes, root) {
    let sub = [];
    nodes.forEach((node) => {
      list.unshift(node.queryPath);
      delete node.__roots[root];
      if (!Object.keys(node.__roots).length) {
        delete fileMap[node.queryPath];
      }
      node.requires && node.requires.forEach(function (reqPath) {
        let req = fileMap[reqPath];
        if (!req || !req.__roots[root]) {
          return;
        }
        let len = Object.keys(req.__roots);
        if (len === 0) {
          // this is impossible
        } else if (len === 1) {
          sub.push(req);
        } else {
          delete req.__roots[root];
        }
      });
    });
    return sub;
  }

  function findRoot(mods) {
    let root = [];
    mods.forEach(function (k) {
      let tmp = requiredMap[k];
      let parents = Object.keys(tmp);
      if (parents.length === 0) {
        roots.push(k);
      }
    });
    return root;
  }

  // 找出根节点
  console.log('find root file');
  let mods = Object.keys(requiredMap);
  let roots = findRoot(mods);
  // merge custom roots
  if (exportModules && exportModules.length) {
    roots = roots.concat(exportModules);
  }
  roots = unique(roots);

  // 标记各文件的root
  roots.forEach(function (root) {
    let sub = [root];
    while(sub.length) {
      sub = markRoot(sub, root);
    }
  });

  let res = {};
  let noneRootFiles = [];
  roots.forEach(function (root) {
    let list = [];
    let tmp = [fileMap[root]];
    while (tmp.length) {
      tmp = mergeFile(list, tmp, root);
    }
    res[root] = list;
  });
  // merge 第一步，入口文件，交叉文件入common
  console.log(res);

  let restFile = Object.keys(fileMap);
  while (restFile) {

  }
  console.log(fileMap);

}
/**
 * processFile
 * @param  {Cube}   cube   cube instance
 * @param  {Object} data
 *         - src abs file path
 *         - dest output dir
 *         - destFile output file
 * @param  {Function} cb(err, res)
 */
function processFile(cube, options, cb) {
  var source = options.src;
  var dest = options.dest;

  if (!cb) {
    cb = function () {};
  }
  var st = new Date().getTime();
  var root = cube.config.root;


  var realFile = utils.fixWinPath(source.substr(root.length));
  // var queryFile = freezeDest ? fixWinPath(dest.substr(root.length)) : realFile;
  var queryFile = realFile;
  var destFile = options.destFile;
  if (dest) {
    destFile = path.join(dest, realFile);
  }
  // var destMapFile = path.join(dest, relFile.replace(/\.(\w+)$/, '.map'));
  // var fileName = path.basename(relFile);
  var ext = path.extname(realFile);

  var type =  cube.extMap[ext];
  if (type === undefined) {
    if (destFile) {
      console.log('[copying file]:', realFile.substr(1));
      destFile && xfs.sync().save(destFile, xfs.readFileSync(source));
      return cb();
    } else {
      // unknow type, copy file
      console.log('[unknow file type]', realFile.substr(1));
      return cb('unknow_type');
    }
  }
  var ps = cube.processors[type];
  var processors = ps[ext];

  console.log('[transfer ' + type + ']:', realFile.substr(1));

  async.waterfall([
    function prepare(done) {
      let data = {
        queryPath: queryFile,
        realPath: realFile,
        type: type,
        code: null,
        codeWraped: null,
        source: null,
        sourceMap: null,
        processors: processors,
        wrap: true,
        compress: options.compress !== undefined ? data.compress : cube.config.compress
      };
      done(null, data);
    },
    cube.seekFile.bind(cube),
    cube.readFile.bind(cube),
    cube.transferCode.bind(cube),
    function (data, done) {
      data.genCode(done);
    },
    function output(data, done) {
      let flagWithoutWrap = !data.wrap;
      if (dest) {
        var finalFile, wrapDestFile;
        destFile = path.join(dest, data.queryPath.replace(/^\w+:/, ''));
        if (type === 'script') {
          /**
           * script type, write single js file
           */
          wrapDestFile = destFile; // .replace(/(\.\w+)?$/, '.js');
          xfs.sync().save(wrapDestFile, flagWithoutWrap ? data.code : data.codeWraped);
          // var destSourceFile = destFile.replace(/\.js/, '.source.js');
          // withSource && xfs.sync().save(destSourceFile, result.source);
        } else if (type === 'style') {
          /**
           * style type, should write both js file and css file
           */
          finalFile = path.join(dest, realFile).replace(/(\.\w+)?$/, '.css');
          wrapDestFile = destFile;
          xfs.sync().save(wrapDestFile, flagWithoutWrap ? data.code : data.codeWraped);
          xfs.sync().save(finalFile, data.code);
        } else if (type === 'template') {
          wrapDestFile = destFile;
          if (/\.html?$/.test(ext)) {
            xfs.sync().save(path.join(dest, data.realPath), data.source);
          }
          xfs.sync().save(wrapDestFile, flagWithoutWrap ? data.code : data.codeWraped);
        }
      } else if (destFile) {
        xfs.sync().save(destFile, flagWithoutWrap ? data.code : data.codeWraped);
      }
      var end = new Date().getTime();
      if (data) {
        data.file = realFile;
      }
      done(null, {
        total: 1,
        time: Math.ceil((end - st) / 1000),
        data: data
      });
    }
  ], cb);
}

/**
 * [allInOneCode description]
 * @param  {Cube}   cube     [description]
 * @param  {Object}   options
 *                       - queryPath
 *                       - compress
 *                       - code
 * @param  {Function} callback [description]
 * @return {[type]}            [description]
 */
function allInOneCode(cube, options, callback) {
  var result = {};

  function prepare(options) {
    return {
      queryPath: options.queryPath,
      realPath: options.queryPath,
      type: 'script',
      ext: '.js',
      targetExt: '.js',
      code: options.code || null,
      codeWraped: null,
      source: options.code || '',
      sourceMap: null,
      wrap: (options.ignoreFirstCodeWrap) ? false : true,
      compress: options.compress !== undefined ? options.compress : cube.config.compress
    };
  }
  function process(cube, data, cb) {
    async.waterfall([
      function prepare(done) {
        done(null, data);
      },
      cube.readFile.bind(cube),
      cube.transferCode.bind(cube)
    ], function (err, data) {
      if (err) {
        return cb(err);
      }
      result[data.queryPath] = data;
      if (data.requires && data.requires.length) {
        async.eachLimit(data.requires, 10, function (req, done) {
          if (result[req]) {
            return done(null);
          }
          process(cube, prepare({
            queryPath: req,
            compress: options.compress
          }), done);
        }, cb);
      } else {
        cb(null);
      }
    });
  }
  process(cube, prepare(options), function (err) {
    if (err) {
      return callback(err);
    }
    let arr = [];
    async.eachSeries(result, function (data, done) {
      data.requires = [];
      data.genCode(function (err, data) {
        if (err) {
          return done(err);
        }
        arr.unshift(data.wrap ? data.codeWraped : data.code);
        done(null);
      });
    }, function (err) {
      callback(err, arr);
    });
  });
}

/**
 * portal API
 */
exports.allInOneCode = allInOneCode;
exports.processFile = processFile;
exports.processDir = processDir;
exports.processDirSmart = processDirSmart;
exports.processFileWithRequires = processFileWithRequires;
