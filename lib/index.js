'use strict';

var pouchdbBinaryUtils = require('pouchdb-binary-utils');
var pouchdbAdapterUtils = require('pouchdb-adapter-utils');
var pouchdbMd5 = require('pouchdb-md5');
var pouchdbUtils = require('pouchdb-utils');
var pouchdbErrors = require('pouchdb-errors');
var pouchdbMerge = require('pouchdb-merge');

var IDB_NULL = Number.MIN_SAFE_INTEGER;
var IDB_FALSE = Number.MIN_SAFE_INTEGER + 1;
var IDB_TRUE = Number.MIN_SAFE_INTEGER + 2;

//
// IndexedDB only allows valid JS names in its index paths, whereas JSON allows
// for any string at all. This converts invalid JS names to valid ones, to allow
// for them to be indexed.
//
// For example, "foo-bar" is a valid JSON key, but cannot be a valid JS name
// (because that would be read as foo minus bar).
//
// Very high level rules for valid JS names are:
//  - First character cannot start with a number
//  - Otherwise all characters must be be a-z, A-Z, 0-9, $ or _.
//  - We allow . unless the name represents a single field, as that represents
//    a deep index path.
//
// This is more aggressive than it needs to be, but also simpler.
//
var KEY_INVALID = /[^a-zA-Z0-9_$]+|(^[^a-zA-Z_$])/g;
var PATH_INVALID = /(\\.)|[^a-zA-Z0-9_$.]+|(^[^a-zA-Z_$])/g;
var SLASH = '\\'.charCodeAt(0);

// These are the same as above but without the global flag
// we want to use RegExp.test because it's really fast, but the global flag
// makes the regex const stateful (seriously) as it walked through all instances
var TEST_KEY_INVALID = /[^a-zA-Z0-9_$]+|(^[^a-zA-Z_$])/;
var TEST_PATH_INVALID = /(\\.)|[^a-zA-Z0-9_$.]+|(^[^a-zA-Z_$])/;
function needsSanitise(name, isPath) {
  if (isPath) {
    return TEST_PATH_INVALID.test(name);
  } else {
    return TEST_KEY_INVALID.test(name);
  }
}

function sanitise(name, isPath) {
  var correctCharacters = function (match) {
    var good = '';
    for (var i = 0; i < match.length; i++) {
      var code = match.charCodeAt(i);
      // If you're sanitising a path, a slash character is there to be interpreted
      // by whatever parses the path later as "escape the next thing".
      //
      // e.g., if you want to index THIS string:
      //   {"foo": {"bar.baz": "THIS"}}
      // Your index path would be "foo.bar\.baz".
      if (code === SLASH && isPath) {
        continue;
      }

      good += '_c' + code + '_';
    }
    return good;
  };

  if (isPath) {
    return name.replace(PATH_INVALID, correctCharacters);
  } else {
    return name.replace(KEY_INVALID, correctCharacters);
  }
}

function needsRewrite(data) {
  for (var key of Object.keys(data)) {
    if (needsSanitise(key)) {
      return true;
    } else if (data[key] === null || typeof data[key] === 'boolean') {
      return true;
    } else if (typeof data[key] === 'object') {
      return needsRewrite(data[key]);
    }
  }
}

function rewrite(data) {
  if (!needsRewrite(data)) {
    return false;
  }

  var isArray = Array.isArray(data);
  var clone = isArray
    ? []
    : {};

  Object.keys(data).forEach(function (key) {
    var safeKey = isArray ? key : sanitise(key);

    if (data[key] === null) {
      clone[safeKey] = IDB_NULL;
    } else if (typeof data[key] === 'boolean') {
      clone[safeKey] = data[key] ? IDB_TRUE : IDB_FALSE;
    } else if (typeof data[key] === 'object') {
      clone[safeKey] = rewrite(data[key]);
    } else {
      clone[safeKey] = data[key];
    }
  });

  return clone;
}

var DOC_STORE = 'docs';
var META_STORE = 'meta';

function idbError(callback) {
  return function (evt) {
    var message = 'unknown_error';
    if (evt.target && evt.target.error) {
      message = evt.target.error.name || evt.target.error.message;
    }
    callback(pouchdbErrors.createError(pouchdbErrors.IDB_ERROR, message, evt.type));
  };
}

function processAttachment(name, src, doc, isBinary) {

  delete doc._attachments[name].stub;

  if (isBinary) {
    doc._attachments[name].data =
      src.attachments[doc._attachments[name].digest].data;
    return Promise.resolve();
  }

  return new Promise(function (resolve) {
    var data = src.attachments[doc._attachments[name].digest].data;
    pouchdbBinaryUtils.readAsBinaryString(data, function (binString) {
      doc._attachments[name].data = pouchdbBinaryUtils.btoa(binString);
      delete doc._attachments[name].length;
      resolve();
    });
  });
}

function rawIndexFields(ddoc, viewName) {
  // fields are an array of either the string name of the field, or a key value
  var fields = ddoc.views[viewName].options &&
               ddoc.views[viewName].options.def &&
               ddoc.views[viewName].options.def.fields || [];

  // Either ['foo'] or [{'foo': 'desc'}]
  return fields.map(function (field) {
    if (typeof field === 'string') {
      return field;
    } else {
      return Object.keys(field)[0];
    }
  });
}

function naturalIndexName(fields) {
  return '_find_idx/' + fields.join('/');
}

/**
 * Convert the fields the user gave us in the view and convert them to work for
 * indexeddb.
 *
 * fields is an array of field strings. A field string could be one field:
 *   'foo'
 * Or it could be a json path:
 *   'foo.bar'
 */
function correctIndexFields(fields) {
  // Every index has to have deleted at the front, because when we do a query
  // we need to filter out deleted documents.
  return ['deleted'].concat(
    fields.map(function (field) {
      if (field in ['_id', '_rev', '_deleted', '_attachments']) {
        // These properties are stored at the top level without the underscore
        return field.substr(1);
      } else {
        // The custom document fields are inside the `data` property
        return 'data.' + sanitise(field, true);
      }
    })
  );
}

//
// Core PouchDB schema version. Increment this if we, as a library, want to make
// schema changes in indexeddb. See upgradePouchDbSchema()
//
var POUCHDB_IDB_VERSION = 1;

//
// Functions that manage a combinate indexeddb version, by combining the current
// time in millis that represents user migrations with a large multiplier that
// represents PouchDB system migrations.
//
// This lets us use the idb version number to both represent
// PouchDB-library-level migrations as well as "user migrations" required for
// when design documents trigger the addition or removal of native indexes.
//
// Given that Number.MAX_SAFE_INTEGER = 9007199254740991
//
// We can easily use the largest 2-3 digits and either allow:
//  - 900 system migrations up to 2198/02/18
//  - or 89 system migrations up to 5050/02/14
//
// This impl does the former. If this code still exists after 2198 someone send my
// decendents a Spacebook message congratulating them on their impressive genes.
//
// 9007199254740991 <- MAX_SAFE_INTEGER
//   10000000000000 <- 10^13
//    7199254740991 <- 2198-02-18T16:59:00.991Z
//
var versionMultiplier = Math.pow(10, 13);
function createIdbVersion() {
  return (versionMultiplier * POUCHDB_IDB_VERSION) + new Date().getTime();
}
function getPouchDbVersion(version) {
  return Math.floor(version / versionMultiplier);
}

function maintainNativeIndexes(openReq, reject) {
  var docStore = openReq.transaction.objectStore(DOC_STORE);
  var ddocsReq = docStore.getAll(IDBKeyRange.bound('_design/', '_design/\uffff'));

  ddocsReq.onsuccess = function (e) {
    var results = e.target.result;
    var existingIndexNames = Array.from(docStore.indexNames);

    // NB: the only thing we're supporting here is the declared indexing
    // fields nothing more.
    var expectedIndexes = results.filter(function (row) {
      return row.deleted === 0 && row.revs[row.rev].data.views;
    }).map(function (row) {
      return row.revs[row.rev].data;
    }).reduce(function (indexes, ddoc) {
      return Object.keys(ddoc.views).reduce(function (acc, viewName) {
        var fields = rawIndexFields(ddoc, viewName);

        if (fields && fields.length > 0) {
          acc[naturalIndexName(fields)] = correctIndexFields(fields);
        }

        return acc;
      }, indexes);
    }, {});

    var expectedIndexNames = Object.keys(expectedIndexes);

    // Delete any indexes that aren't system indexes or expected
    var systemIndexNames = ['seq'];
    existingIndexNames.forEach(function (index) {
      if (systemIndexNames.indexOf(index) === -1  && expectedIndexNames.indexOf(index) === -1) {
        docStore.deleteIndex(index);
      }
    });

    // Work out which indexes are missing and create them
    var newIndexNames = expectedIndexNames.filter(function (ei) {
      return existingIndexNames.indexOf(ei) === -1;
    });

    try {
      newIndexNames.forEach(function (indexName) {
        docStore.createIndex(indexName, expectedIndexes[indexName]);
      });
    } catch (err) {
      reject(err);
    }
  };
}

function upgradePouchDbSchema(db, pouchdbVersion) {
  if (pouchdbVersion < 1) {
    var docStore = db.createObjectStore(DOC_STORE, {keyPath : 'id'});
    docStore.createIndex('seq', 'seq', {unique: true});

    db.createObjectStore(META_STORE, {keyPath: 'id'});
  }

  // Declare more PouchDB schema changes here
  // if (pouchdbVersion < 2) { .. }
}

function openDatabase(openDatabases, api, opts, resolve, reject) {
  var openReq = opts.versionchanged ?
    indexedDB.open(opts.name) :
    indexedDB.open(opts.name, createIdbVersion());

  openReq.onupgradeneeded = function (e) {
    if (e.oldVersion > 0 && e.oldVersion < versionMultiplier) {
      // This DB was created with the "idb" adapter, **not** this one.
      // For now we're going to just error out here: users must manually
      // migrate between the two. In the future, dependent on performance tests,
      // we might silently migrate
      throw new Error('Incorrect adapter: you should specify the "idb" adapter to open this DB');
    }

    var db = e.target.result;

    var pouchdbVersion = getPouchDbVersion(e.oldVersion);
    upgradePouchDbSchema(db, pouchdbVersion);
    maintainNativeIndexes(openReq, reject);
  };

  openReq.onblocked = function (e) {
      // AFAICT this only occurs if, after sending `onversionchange` events to
      // all other open DBs (ie in different tabs), there are still open
      // connections to the DB. In this code we should never see this because we
      // close our DBs on these events, and all DB interactions are wrapped in
      // safely re-opening the DB.
      console.error('onblocked, this should never happen', e);
  };

  openReq.onsuccess = function (e) {
    var idb = e.target.result;

    idb.onabort = function (e) {
      console.error('Database has a global failure', e.target.error);
      delete openDatabases[opts.name];
      idb.close();
    };

    idb.onversionchange = function () {
      console.log('Database was made stale, closing handle');
      openDatabases[opts.name].versionchanged = true;
      idb.close();
    };

    var metadata = {id: META_STORE};
    var txn = idb.transaction([META_STORE], 'readwrite');

    txn.oncomplete = function () {
      resolve({idb: idb, metadata: metadata});
    };

    var metaStore = txn.objectStore(META_STORE);
    metaStore.get(META_STORE).onsuccess = function (e) {
      metadata = e.target.result || metadata;
      var changed = false;

      if (!('doc_count' in metadata)) {
        changed = true;
        metadata.doc_count = 0;
      }

      if (!('seq' in metadata)) {
        changed = true;
        metadata.seq = 0;
      }

      if (!('db_uuid' in metadata)) {
        changed = true;
        metadata.db_uuid = pouchdbUtils.uuid();
      }

      if (changed) {
        metaStore.put(metadata);
      }
    };
  };

  openReq.onerror = function (e) {
    reject(e.target.error);
  };
}

function setup (openDatabases, api, opts) {
  if (!openDatabases[opts.name] || openDatabases[opts.name].versionchanged) {
    opts.versionchanged = openDatabases[opts.name] &&
                          openDatabases[opts.name].versionchanged;

    openDatabases[opts.name] = new Promise(function (resolve, reject) {
      openDatabase(openDatabases, api, opts, resolve, reject);
    });
  }

  return openDatabases[opts.name];
}

function info (metadata, callback) {
  callback(null, {
    doc_count: metadata.doc_count,
    update_seq: metadata.seq
  });
}

function get (txn, id, opts, callback) {
  if (txn.error) {
    return callback(txn.error);
  }

  txn.txn.objectStore(DOC_STORE).get(id).onsuccess = function (e) {
    var doc = e.target.result;
    var rev;
    if (!opts.rev) {
      rev = (doc && doc.rev);
    } else {
      rev = opts.latest ? pouchdbMerge.latest(opts.rev, doc) : opts.rev;
    }

    if (!doc || (doc.deleted && !opts.rev) || !(rev in doc.revs)) {
      callback(pouchdbErrors.createError(pouchdbErrors.MISSING_DOC, 'missing'));
      return;
    }

    var result = doc.revs[rev].data;
    result._id = doc.id;
    result._rev = rev;

    // WARNING: expecting possible old format
    // TODO: why are we passing the transaction in the context?
    //       It's not clear we ever thread these txns usefully
    callback(null, {
      doc: result,
      metadata: doc,
      ctx: txn
    });
  };
}

function parseAttachment(attachment, opts, cb) {
  if (opts.binary) {
    return cb(null, attachment);
  } else {
    pouchdbBinaryUtils.readAsBinaryString(attachment, function (binString) {
      cb(null, pouchdbBinaryUtils.btoa(binString));
    });
  }
}

function getAttachment(txn, docId, attachId, _, opts, cb) {
  if (txn.error) {
    return cb(txn.error);
  }

  var attachment;

  txn.txn.objectStore(DOC_STORE).get(docId).onsuccess = function (e) {
    var doc = e.target.result;
    var rev = doc.revs[opts.rev || doc.rev].data;
    var digest = rev._attachments[attachId].digest;
    attachment = doc.attachments[digest].data;
  };

  txn.txn.oncomplete = function () {
    parseAttachment(attachment, opts, cb);
  };

  txn.txn.onabort = cb;
}

function bulkDocs (api, req, opts, metadata, dbOpts, idbChanges, callback) {

  var txn;

  // TODO: I would prefer to get rid of these globals
  var error;
  var results = [];
  var docs = [];
  var lastWriteIndex;

  var revsLimit = dbOpts.revs_limit || 1000;
  var rewriteEnabled = dbOpts.name.indexOf("-mrview-") === -1;

  // We only need to track 1 revision for local documents
  function docsRevsLimit(doc) {
    return /^_local/.test(doc.id) ? 1 : revsLimit;
  }

  function rootIsMissing(doc) {
    return doc.rev_tree[0].ids[1].status === 'missing';
  }

  function parseBase64(data) {
    try {
      return atob(data);
    } catch (e) {
      return {
        error: pouchdbErrors.createError(pouchdbErrors.BAD_ARG, 'Attachment is not a valid base64 string')
      };
    }
  }

  // Reads the original doc from the store if available
  // As in allDocs with keys option using multiple get calls is the fastest way
  function fetchExistingDocs(txn, docs) {
    var fetched = 0;
    var oldDocs = {};

    function readDone(e) {
      if (e.target.result) {
        oldDocs[e.target.result.id] = e.target.result;
      }
      if (++fetched === docs.length) {
        processDocs(txn, docs, oldDocs);
      }
    }

    docs.forEach(function (doc) {
      txn.objectStore(DOC_STORE).get(doc.id).onsuccess = readDone;
    });
  }

  function processDocs(txn, docs, oldDocs) {

    docs.forEach(function (doc, i) {
      var newDoc;

      // The first document write cannot be a deletion
      if ('was_delete' in opts && !(oldDocs.hasOwnProperty(doc.id))) {
        newDoc = pouchdbErrors.createError(pouchdbErrors.MISSING_DOC, 'deleted');

      // The first write of a document cannot specify a revision
      } else if (opts.new_edits &&
                 !oldDocs.hasOwnProperty(doc.id) &&
                 rootIsMissing(doc)) {
        newDoc = pouchdbErrors.createError(pouchdbErrors.REV_CONFLICT);

      // Update the existing document
      } else if (oldDocs.hasOwnProperty(doc.id)) {
        newDoc = update(txn, doc, oldDocs[doc.id]);
        // The update can be rejected if it is an update to an existing
        // revision, if so skip it
        if (newDoc == false) {
          return;
        }

      // New document
      } else {
        // Ensure new documents are also stemmed
        var merged = pouchdbMerge.merge([], doc.rev_tree[0], docsRevsLimit(doc));
        doc.rev_tree = merged.tree;
        doc.stemmedRevs = merged.stemmedRevs;
        newDoc = doc;
        newDoc.isNewDoc = true;
        newDoc.wasDeleted = doc.revs[doc.rev].deleted ? 1 : 0;
      }

      if (newDoc.error) {
        results[i] = newDoc;
      } else {
        oldDocs[newDoc.id] = newDoc;
        lastWriteIndex = i;
        write(txn, newDoc, i);
      }
    });
  }

  // Converts from the format returned by parseDoc into the new format
  // we use to store
  function convertDocFormat(doc) {

    var newDoc = {
      id: doc.metadata.id,
      rev: doc.metadata.rev,
      rev_tree: doc.metadata.rev_tree,
      revs: doc.metadata.revs || {}
    };

    newDoc.revs[newDoc.rev] = {
      data: doc.data,
      deleted: doc.metadata.deleted
    };

    return newDoc;
  }

  function update(txn, doc, oldDoc) {

    // Ignore updates to existing revisions
    if ((doc.rev in oldDoc.revs) && !opts.new_edits) {
      return false;
    }

    var isRoot = /^1-/.test(doc.rev);

    // Reattach first writes after a deletion to last deleted tree
    if (oldDoc.deleted && !doc.deleted && opts.new_edits && isRoot) {
      var tmp = doc.revs[doc.rev].data;
      tmp._rev = oldDoc.rev;
      tmp._id = oldDoc.id;
      doc = convertDocFormat(pouchdbAdapterUtils.parseDoc(tmp, opts.new_edits, dbOpts));
    }

    var merged = pouchdbMerge.merge(oldDoc.rev_tree, doc.rev_tree[0], docsRevsLimit(doc));
    doc.stemmedRevs = merged.stemmedRevs;
    doc.rev_tree = merged.tree;

    // Merge the old and new rev data
    var revs = oldDoc.revs;
    revs[doc.rev] = doc.revs[doc.rev];
    doc.revs = revs;

    doc.attachments = oldDoc.attachments;

    var inConflict = opts.new_edits && (((oldDoc.deleted && doc.deleted) ||
       (!oldDoc.deleted && merged.conflicts !== 'new_leaf') ||
       (oldDoc.deleted && !doc.deleted && merged.conflicts === 'new_branch') ||
       (oldDoc.rev === doc.rev)));

    if (inConflict) {
      return pouchdbErrors.createError(pouchdbErrors.REV_CONFLICT);
    }

    doc.wasDeleted = oldDoc.deleted;

    return doc;
  }

  function write(txn, doc, i) {

    // We copy the data from the winning revision into the root
    // of the document so that it can be indexed
    var winningRev = pouchdbMerge.winningRev(doc);
    // rev of new doc for attachments and to return it
    var writtenRev = doc.rev;
    var isLocal = /^_local/.test(doc.id);

    var theDoc = doc.revs[winningRev].data;

    if (rewriteEnabled) {
      // doc.data is what we index, so we need to clone and rewrite it, and clean
      // it up for indexability
      var result = rewrite(theDoc);
      if (result) {
        doc.data = result;
        delete doc.data._attachments;
      } else {
        doc.data = theDoc;
      }
    } else {
      doc.data = theDoc;
    }

    doc.rev = winningRev;
    // .deleted needs to be an int for indexing
    doc.deleted = doc.revs[winningRev].deleted ? 1 : 0;

    // Bump the seq for every new (non local) revision written
    // TODO: index expects a unique seq, not sure if ignoring local will
    // work
    if (!isLocal) {
      doc.seq = ++metadata.seq;

      var delta = 0;
      // If its a new document, we wont decrement if deleted
      if (doc.isNewDoc) {
        delta = doc.deleted ? 0 : 1;
      } else if (doc.wasDeleted !== doc.deleted) {
        delta = doc.deleted ? -1 : 1;
      }
      metadata.doc_count += delta;
    }
    delete doc.isNewDoc;
    delete doc.wasDeleted;

    // If there have been revisions stemmed when merging trees,
    // delete their data
    if (doc.stemmedRevs) {
      doc.stemmedRevs.forEach(function (rev) { delete doc.revs[rev]; });
    }
    delete doc.stemmedRevs;

    if (!('attachments' in doc)) {
      doc.attachments = {};
    }

    if (theDoc._attachments) {
      for (var k in theDoc._attachments) {
        var attachment = theDoc._attachments[k];
        if (attachment.stub) {
          if (!(attachment.digest in doc.attachments)) {
            error = pouchdbErrors.createError(pouchdbErrors.MISSING_STUB);
            // TODO: Not sure how safe this manual abort is, seeing
            // console issues
            txn.abort();
            return;
          }

          doc.attachments[attachment.digest].revs[writtenRev] = true;

        } else {

          doc.attachments[attachment.digest] = attachment;
          doc.attachments[attachment.digest].revs = {};
          doc.attachments[attachment.digest].revs[writtenRev] = true;

          theDoc._attachments[k] = {
            stub: true,
            digest: attachment.digest,
            content_type: attachment.content_type,
            length: attachment.length,
            revpos: parseInt(writtenRev, 10)
          };
        }
      }
    }

    // Local documents have different revision handling
    if (isLocal && doc.deleted) {
      txn.objectStore(DOC_STORE).delete(doc.id).onsuccess = function () {
        results[i] = {
          ok: true,
          id: doc.id,
          rev: '0-0'
        };
      };
      updateSeq(i);
      return;
    }

    txn.objectStore(DOC_STORE).put(doc).onsuccess = function () {
      results[i] = {
        ok: true,
        id: doc.id,
        rev: writtenRev
      };
      updateSeq(i);
    };
  }

  function updateSeq(i) {
    if (i === lastWriteIndex) {
      txn.objectStore(META_STORE).put(metadata);
    }
  }

  function preProcessAttachment(attachment) {
    if (attachment.stub) {
      return Promise.resolve(attachment);
    }

    var binData;
    if (typeof attachment.data === 'string') {
      binData = parseBase64(attachment.data);
      if (binData.error) {
        return Promise.reject(binData.error);
      }
      attachment.data = pouchdbBinaryUtils.binaryStringToBlobOrBuffer(binData, attachment.content_type);
    } else {
      binData = attachment.data;
    }

    return new Promise(function (resolve) {
      pouchdbMd5.binaryMd5(binData, function (result) {
        attachment.digest = 'md5-' + result;
        attachment.length = binData.size || binData.length || 0;
        resolve(attachment);
      });
    });
  }

  function preProcessAttachments() {
    var promises = docs.map(function (doc) {
      var data = doc.revs[doc.rev].data;
      if (!data._attachments) {
        return Promise.resolve(data);
      }
      var attachments = Object.keys(data._attachments).map(function (k) {
        data._attachments[k].name = k;
        return preProcessAttachment(data._attachments[k]);
      });

      return Promise.all(attachments).then(function (newAttachments) {
        var processed = {};
        newAttachments.forEach(function (attachment) {
          processed[attachment.name] = attachment;
          delete attachment.name;
        });
        data._attachments = processed;
        return data;
      });
    });
    return Promise.all(promises);
  }

  for (var i = 0, len = req.docs.length; i < len; i++) {
    var result;
    // TODO: We should get rid of throwing for invalid docs, also not sure
    // why this is needed in idb-next and not idb
    try {
      result = pouchdbAdapterUtils.parseDoc(req.docs[i], opts.new_edits, dbOpts);
    } catch (err) {
      result = err;
    }
    if (result.error) {
      return callback(result);
    }

    // Ideally parseDoc would return data in this format, but it is currently
    // shared so we need to convert
    docs.push(convertDocFormat(result));
  }

  preProcessAttachments().then(function () {
    api._openTransactionSafely([DOC_STORE, META_STORE], 'readwrite', function (err, _txn) {
      if (err) {
        return callback(err);
      }

      txn = _txn;

      txn.onabort = function () {
        callback(error);
      };
      txn.ontimeout = idbError(callback);

      txn.oncomplete = function () {
        idbChanges.notify(dbOpts.name);
        callback(null, results);
      };

      // We would like to use promises here, but idb sucks
      fetchExistingDocs(txn, docs);
    });
  }).catch(function (err) {
    callback(err);
  });
}

function allDocsKeys(keys, docStore, allDocsInner) {
  // It's not guaranted to be returned in right order
  var valuesBatch = new Array(keys.length);
  var count = 0;
  keys.forEach(function (key, index) {
    docStore.get(key).onsuccess = function (event) {
      if (event.target.result) {
      valuesBatch[index] = event.target.result;
      } else {
        valuesBatch[index] = {key: key, error: 'not_found'};
      }
      count++;
      if (count === keys.length) {
        valuesBatch.forEach(function (doc) {
            allDocsInner(doc);
        });
      }
    };
  });
}

function createKeyRange(start, end, inclusiveEnd, key, descending) {
  try {
    if (start && end) {
      if (descending) {
        return IDBKeyRange.bound(end, start, !inclusiveEnd, false);
      } else {
        return IDBKeyRange.bound(start, end, false, !inclusiveEnd);
      }
    } else if (start) {
      if (descending) {
        return IDBKeyRange.upperBound(start);
      } else {
        return IDBKeyRange.lowerBound(start);
      }
    } else if (end) {
      if (descending) {
        return IDBKeyRange.lowerBound(end, !inclusiveEnd);
      } else {
        return IDBKeyRange.upperBound(end, !inclusiveEnd);
      }
    } else if (key) {
      return IDBKeyRange.only(key);
    }
  } catch (e) {
    return {error: e};
  }
  return null;
}

function handleKeyRangeError(opts, metadata, err, callback) {
  if (err.name === "DataError" && err.code === 0) {
    // data error, start is less than end
    var returnVal = {
      total_rows: metadata.doc_count,
      offset: opts.skip,
      rows: []
    };
    /* istanbul ignore if */
    if (opts.update_seq) {
      returnVal.update_seq = metadata.seq;
    }
    return callback(null, returnVal);
  }
  callback(pouchdbErrors.createError(pouchdbErrors.IDB_ERROR, err.name, err.message));
}

function allDocs (txn, metadata, opts, callback) {
  if (txn.error) {
    return callback(txn.error);
  }

  // TODO: Weird hack, I dont like it
  if (opts.limit === 0) {
    var returnVal = {
      total_rows: metadata.doc_count,
      offset: opts.skip,
      rows: []
    };

    /* istanbul ignore if */
    if (opts.update_seq) {
      returnVal.update_seq = metadata.seq;
    }
    return callback(null, returnVal);
  }

  var results = [];
  var processing = [];

  var start = 'startkey' in opts ? opts.startkey : false;
  var end = 'endkey' in opts ? opts.endkey : false;
  var key = 'key' in opts ? opts.key : false;
  var keys = 'keys' in opts ? opts.keys : false;
  var skip = opts.skip || 0;
  var limit = typeof opts.limit === 'number' ? opts.limit : -1;
  var inclusiveEnd = opts.inclusive_end !== false;
  var descending = 'descending' in opts && opts.descending ? 'prev' : null;

  var keyRange;
  if (!keys) {
    keyRange = createKeyRange(start, end, inclusiveEnd, key, descending);
    if (keyRange && keyRange.error) {
      return handleKeyRangeError(opts, metadata, keyRange.error, callback);
    }
  }

  var docStore = txn.txn.objectStore(DOC_STORE);

  txn.txn.oncomplete = onTxnComplete;

  if (keys) {
    return allDocsKeys(opts.keys, docStore, allDocsInner);
  }

  function include_doc(row, doc) {
    var docData = doc.revs[doc.rev].data;

    row.doc = docData;
    row.doc._id = doc.id;
    row.doc._rev = doc.rev;
    if (opts.conflicts) {
      var conflicts = pouchdbMerge.collectConflicts(doc);
      if (conflicts.length) {
        row.doc._conflicts = conflicts;
      }
    }
    if (opts.attachments && docData._attachments) {
      for (var name in docData._attachments) {
        processing.push(processAttachment(name, doc, row.doc, opts.binary));
      }
    }
  }

  function allDocsInner(doc) {
    if (doc.error && keys) {
      // key was not found with "keys" requests
      results.push(doc);
      return true;
    }

    var row = {
      id: doc.id,
      key: doc.id,
      value: {
        rev: doc.rev
      }
    };

    var deleted = doc.deleted;
    if (deleted) {
      if (keys) {
        results.push(row);
        row.value.deleted = true;
        row.doc = null;
      }
    } else if (skip-- <= 0) {
      results.push(row);
      if (opts.include_docs) {
        include_doc(row, doc);
      }
      if (--limit === 0) {
        return false;
      }
    }
    return true;
  }

  function onTxnComplete() {
    Promise.all(processing).then(function () {
      var returnVal = {
        total_rows: metadata.doc_count,
        offset: 0,
        rows: results
      };

      /* istanbul ignore if */
      if (opts.update_seq) {
        returnVal.update_seq = metadata.seq;
      }
      callback(null, returnVal);
    });
  }

  var cursor = descending ?
    docStore.openCursor(keyRange, descending) :
    docStore.openCursor(keyRange);

  cursor.onsuccess = function (e) {

    var doc = e.target.result && e.target.result.value;

    // Happens if opts does not have limit,
    // because cursor will end normally then,
    // when all docs are retrieved.
    // Would not be needed, if getAll() optimization was used like in #6059
    if (!doc) { return; }

    // Skip local docs
    if (/^_local/.test(doc.id)) {
      return e.target.result.continue();
    }

    var continueCursor = allDocsInner(doc);
    if (continueCursor) {
      e.target.result.continue();
    }
  };

}

function changes (txn, idbChanges, api, dbOpts, opts) {
  if (txn.error) {
    return opts.complete(txn.error);
  }

  if (opts.continuous) {
    var id = dbOpts.name + ':' + pouchdbUtils.uuid();
    idbChanges.addListener(dbOpts.name, id, api, opts);
    idbChanges.notify(dbOpts.name);
    return {
      cancel: function () {
        idbChanges.removeListener(dbOpts.name, id);
      }
    };
  }

  var limit = 'limit' in opts ? opts.limit : -1;
  if (limit === 0) {
    limit = 1;
  }

  var store = txn.txn.objectStore(DOC_STORE).index('seq');

  var filter = pouchdbUtils.filterChange(opts);
  var received = 0;

  var lastSeq = opts.since || 0;
  var results = [];

  var processing = [];

  function onReqSuccess(e) {
    if (!e.target.result) { return; }
    var cursor = e.target.result;
    var doc = cursor.value;
    // Overwrite doc.data, which may have been rewritten (see rewrite.js) with
    // the clean version for that rev
    doc.data = doc.revs[doc.rev].data;
    doc.data._id = doc.id;
    doc.data._rev = doc.rev;
    if (doc.deleted) {
      doc.data._deleted = true;
    }

    if (opts.doc_ids && opts.doc_ids.indexOf(doc.id) === -1) {
      return cursor.continue();
    }

    // WARNING: expecting possible old format
    var change = opts.processChange(doc.data, doc, opts);
    change.seq = doc.seq;
    lastSeq = doc.seq;
    var filtered = filter(change);

    // If its an error
    if (typeof filtered === 'object') {
      return opts.complete(filtered);
    }

    if (filtered) {
      received++;
      if (opts.return_docs) {
        results.push(change);
      }

      if (opts.include_docs && opts.attachments && doc.data._attachments) {
        var promises = [];
        for (var name in doc.data._attachments) {
          var p = processAttachment(name, doc, change.doc, opts.binary);
          // We add the processing promise to 2 arrays, one tracks all
          // the promises needed before we fire onChange, the other
          // ensure we process all attachments before onComplete
          promises.push(p);
          processing.push(p);
        }

        Promise.all(promises).then(function () {
          opts.onChange(change);
        });
      } else {
        opts.onChange(change);
      }
    }
    if (received !== limit) {
      cursor.continue();
    }
  }

  function onTxnComplete() {
    Promise.all(processing).then(function () {
      opts.complete(null, {
        results: results,
        last_seq: lastSeq
      });
    });
  }

  var req;
  if (opts.descending) {
    req = store.openCursor(null, 'prev');
  } else {
    req = store.openCursor(IDBKeyRange.lowerBound(opts.since, true));
  }

  txn.txn.oncomplete = onTxnComplete;
  req.onsuccess = onReqSuccess;
}

function getRevisionTree (txn, id, callback) {
  if (txn.error) {
    return callback(txn.error);
  }

  var req = txn.txn.objectStore(DOC_STORE).get(id);
  req.onsuccess = function (e) {
    if (!e.target.result) {
      callback(pouchdbErrors.createError(pouchdbErrors.MISSING_DOC));
    } else {
      callback(null, e.target.result.rev_tree);
    }
  };
}

function doCompaction (txn, id, revs, callback) {
  if (txn.error) {
    return callback(txn.error);
  }

  var docStore = txn.txn.objectStore(DOC_STORE);

  docStore.get(id).onsuccess = function (e) {
    var doc = e.target.result;

    pouchdbMerge.traverseRevTree(doc.rev_tree, function (isLeaf, pos, revHash, ctx, opts) {
      var rev = pos + '-' + revHash;
      if (revs.indexOf(rev) !== -1) {
        opts.status = 'missing';
      }
    });

    var attachments = [];

    revs.forEach(function (rev) {
      if (rev in doc.revs) {
        // Make a list of attachments that are used by the revisions being
        // deleted
        if (doc.revs[rev].data._attachments) {
          for (var k in doc.revs[rev].data._attachments) {
            attachments.push(doc.revs[rev].data._attachments[k].digest);
          }
        }
        delete doc.revs[rev];
      }
    });

    // Attachments have a list of revisions that are using them, when
    // that list becomes empty we can delete the attachment.
    attachments.forEach(function (digest) {
      revs.forEach(function (rev) {
        delete doc.attachments[digest].revs[rev];
      });
      if (!Object.keys(doc.attachments[digest].revs).length) {
        delete doc.attachments[digest];
      }
    });

    docStore.put(doc);
  };

  txn.txn.oncomplete = function () {
    callback();
  };
}

function destroy (dbOpts, openDatabases, idbChanges, callback) {

  idbChanges.removeAllListeners(dbOpts.name);

  function doDestroy() {
    var req = indexedDB.deleteDatabase(dbOpts.name);
    req.onsuccess = function () {
      delete openDatabases[dbOpts.name];
      callback(null, {ok: true});
    };
  }

  // If the database is open we need to close it
  if (dbOpts.name in openDatabases) {
    openDatabases[dbOpts.name].then(function (res) {
      res.idb.close();
      doDestroy();
    });
  } else {
    doDestroy();
  }

}

// Adapted from
// https://github.com/pouchdb/pouchdb/blob/master/packages/node_modules/pouchdb-find/src/adapters/local/find/query-planner.js#L20-L24
// This could change / improve in the future?
var COUCH_COLLATE_LO = null;
var COUCH_COLLATE_HI = '\uffff'; // actually used as {"\uffff": {}}

// Adapted from: https://www.w3.org/TR/IndexedDB/#compare-two-keys
// Importantly, *there is no upper bound possible* in idb. The ideal data
// structure an infintely deep array:
//   var IDB_COLLATE_HI = []; IDB_COLLATE_HI.push(IDB_COLLATE_HI)
// But IDBKeyRange is not a fan of shenanigans, so I've just gone with 12 layers
// because it looks nice and surely that's enough!
var IDB_COLLATE_LO = Number.NEGATIVE_INFINITY;
var IDB_COLLATE_HI = [[[[[[[[[[[[]]]]]]]]]]]];

//
// TODO: this should be made offical somewhere and used by AllDocs / get /
// changes etc as well.
//
function externaliseRecord(idbDoc) {
  var doc = idbDoc.revs[idbDoc.rev].data;
  doc._id = idbDoc.id;
  doc._rev = idbDoc.rev;
  if (idbDoc.deleted) {
    doc._deleted = true;
  }

  return doc;
}

/**
 * Generates a keyrange based on the opts passed to query
 *
 * The first key is always 0, as that's how we're filtering out deleted entries.
 */
function generateKeyRange(opts) {
  function defined(obj, k) {
    return obj[k] !== void 0;
  }

  // Converts a valid CouchDB key into a valid IndexedDB one
  function convert(key, exact) {
    // The first item in every native index is doc.deleted, and we always want
    // to only search documents that are not deleted.
    // "foo" -> [0, "foo"]
    var filterDeleted = [0].concat(key);

    return filterDeleted.map(function (k) {
      // null, true and false are not indexable by indexeddb. When we write
      // these values we convert them to these constants, and so when we
      // query for them we need to convert the query also.
      if (k === null && exact) {
        // for non-exact queries we treat null as a collate property
        // see `if (!exact)` block below
        return IDB_NULL;
      } else if (k === true) {
        return IDB_TRUE;
      } else if (k === false) {
        return IDB_FALSE;
      }

      if (!exact) {
        // We get passed CouchDB's collate low and high values, so for non-exact
        // ranged queries we're going to convert them to our IDB equivalents
        if (k === COUCH_COLLATE_LO) {
          return IDB_COLLATE_LO;
        } else if (k.hasOwnProperty(COUCH_COLLATE_HI)) {
          return IDB_COLLATE_HI;
        }
      }

      return k;
    });
  }

  // CouchDB and so PouchdB defaults to true. We need to make this explicit as
  // we invert these later for IndexedDB.
  if (!defined(opts, 'inclusive_end')) {
    opts.inclusive_end = true;
  }
  if (!defined(opts, 'inclusive_start')) {
    opts.inclusive_start = true;
  }

  if (opts.descending) {
    // Flip before generating. We'll check descending again later when performing
    // an index request
    var realEndkey = opts.startkey,
        realInclusiveEnd = opts.inclusive_start;

    opts.startkey = opts.endkey;
    opts.endkey = realEndkey;
    opts.inclusive_start = opts.inclusive_end;
    opts.inclusive_end = realInclusiveEnd;
  }

  try {
    if (defined(opts, 'key')) {
      return IDBKeyRange.only(convert(opts.key, true));
    }

    if (defined(opts, 'startkey') && !defined(opts, 'endkey')) {
      return IDBKeyRange.lowerBound(convert(opts.startkey), !opts.inclusive_start);
    }

    if (!defined(opts, 'startkey') && defined(opts, 'endkey')) {
      return IDBKeyRange.upperBound(convert(opts.endkey), !opts.inclusive_end);
    }

    if (defined(opts, 'startkey') && defined(opts, 'endkey')) {
      return IDBKeyRange.bound(
        convert(opts.startkey),    convert(opts.endkey),
        !opts.inclusive_start, !opts.inclusive_end
      );
    }

    return IDBKeyRange.only([0]);
  } catch (err) {
    console.error('Could not generate keyRange', err, opts);
    throw Error('Could not generate key range with ' + JSON.stringify(opts));
  }
}

function getIndexHandle(pdb, fields, reject) {
  var indexName = naturalIndexName(fields);

  return new Promise(function (resolve) {
    pdb._openTransactionSafely([DOC_STORE], 'readonly', function (err, txn) {
      if (err) {
        return idbError(reject)(err);
      }

      txn.onabort = idbError(reject);
      txn.ontimeout = idbError(reject);

      var existingIndexNames = Array.from(txn.objectStore(DOC_STORE).indexNames);

      if (existingIndexNames.indexOf(indexName) === -1) {
        // The index is missing, force a db restart and try again
        pdb._freshen()
          .then(function () { return getIndexHandle(pdb, fields, reject); })
          .then(resolve);
      } else {
        resolve(txn.objectStore(DOC_STORE).index(indexName));
      }
    });
  });
}

// In theory we should return something like the doc example below, but find
// only needs rows: [{doc: {...}}], so I think we can just not bother for now
// {
//   "offset" : 0,
//   "rows": [{
//     "id": "doc3",
//     "key": "Lisa Says",
//     "value": null,
//     "doc": {
//       "_id": "doc3",
//       "_rev": "1-z",
//       "title": "Lisa Says"
//     }
//   }],
//   "total_rows" : 4
// }
function query(idb, signature, opts) {
  // At this stage, in the current implementation, find has already gone through
  // and determined if the index already exists from PouchDB's perspective (eg
  // there is a design doc for it).
  //
  // If we find that the index doesn't exist this means we have to close and
  // re-open the DB to correct indexes before proceeding, at which point the
  // index should exist.

  var pdb = this;

  // Assumption, there will be only one /, between the design document name
  // and the view name.
  var parts = signature.split('/');

  return new Promise(function (resolve, reject) {
    pdb.get('_design/' + parts[0]).then(function (ddoc) {
      var fields = rawIndexFields(ddoc, parts[1]);
      if (!fields) {
        throw new Error('ddoc ' + ddoc._id +' with view ' + parts[1] +
          ' does not have map.options.def.fields defined.');
      }

      var skip = opts.skip;
      var limit = Number.isInteger(opts.limit) && opts.limit;

      return getIndexHandle(pdb, fields, reject)
        .then(function (indexHandle) {
          var keyRange = generateKeyRange(opts);
          var req = indexHandle.openCursor(keyRange, opts.descending ? 'prev' : 'next');

          var rows = [];
          req.onerror = idbError(reject);
          req.onsuccess = function (e) {
            var cursor = e.target.result;

            if (!cursor || limit === 0) {
              return resolve({
                rows: rows
              });
            }

            if (skip) {
              cursor.advance(skip);
              skip = false;
              return;
            }

            if (limit) {
              limit = limit - 1;
            }

            rows.push({doc: externaliseRecord(cursor.value)});
            cursor.continue();
          };
        });
      })
      .catch(reject);
  });

}

function viewCleanup() {
  // I'm not sure we have to do anything here.
  //
  // One option is to just close and re-open the DB, which performs the same
  // action. The only reason you'd want to call this is if you deleted a bunch
  // of indexes and wanted the space back immediately.
  //
  // Otherwise index cleanup happens when:
  //  - A DB is opened
  //  - A find query is performed against an index that doesn't exist but should

  return Promise.resolve();
}

var ADAPTER_NAME = 'indexeddb';

// TODO: Constructor should be capitalised
var idbChanges = new pouchdbUtils.changesHandler();

// A shared list of database handles
var openDatabases = {};

function IdbPouch(dbOpts, callback) {

  var api = this;
  var metadata = {};

  // Wrapper that gives you an active DB handle. You probably want $t.
  var $ = function (fun) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      setup(openDatabases, api, dbOpts).then(function (res) {
        metadata = res.metadata;
        args.unshift(res.idb);
        fun.apply(api, args);
      }).catch(function (err) {
        var last = args.unshift();
        if (typeof last === 'function') {
          last(err);
        } else {
          console.error(err);
        }
      });
    };
  };
  // the promise version of $
  var $p = function (fun) {
    return function () {
      var args = Array.prototype.slice.call(arguments);

      return new Promise(function (resolve, reject) {
        setup(openDatabases, api, dbOpts).then(function (res) {
          metadata = res.metadata;
          args.unshift(res.idb);

          return fun.apply(api, args);
        }).then(resolve)
          .catch(reject);
      });
    };
  };
  // Wrapper that gives you a safe transaction handle. It's important to use
  // this instead of opening your own transaction from a db handle got from $,
  // because in the time between getting the db handle and opening the
  // transaction it may have been invalidated by index changes.
  var $t = function (fun, stores, mode) {
    stores = stores || [DOC_STORE];
    mode = mode || 'readonly';

    return function () {
      var args = Array.prototype.slice.call(arguments);
      var txn = {};
      setup(openDatabases, api, dbOpts).then(function (res) {
        metadata = res.metadata;
        txn.txn = res.idb.transaction(stores, mode);
        args.unshift(txn);
        fun.apply(api, args);
      }).catch(function (err) {
        console.error('Failed to establish transaction safely');
        console.error(err);
        txn.error = err;
      });
    };
  };

  api._openTransactionSafely = function (stores, mode, callback) {
    $t(function (txn, callback) {
      callback(txn.error, txn.txn);
    }, stores, mode)(callback);
  };

  api._remote = false;
  api.type = function () { return ADAPTER_NAME; };

  api._id = $(function (_, cb) {
    cb(null, metadata.db_uuid);
  });

  api._info = $(function (_, cb) {
    return info(metadata, cb);
  });

  api._get = $t(get);

  api._bulkDocs = $(function (_, req, opts, callback) {
    bulkDocs(api, req, opts, metadata, dbOpts, idbChanges, callback);
  });

  api._allDocs = $t(function (txn, opts, cb) {
    allDocs(txn, metadata, opts, cb);
  });

  api._getAttachment = $t(getAttachment);

  api._changes = $t(function (txn, opts) {
    changes(txn, idbChanges, api, dbOpts, opts);
  });

  api._getRevisionTree = $t(getRevisionTree);
  api._doCompaction = $t(doCompaction, [DOC_STORE], 'readwrite');

  api._customFindAbstractMapper = {
    query: $p(query),
    viewCleanup: $p(viewCleanup)
  };

  api._destroy = function (opts, callback) {
    return destroy(dbOpts, openDatabases, idbChanges, callback);
  };

  api._close = $(function (db, cb) {
    delete openDatabases[dbOpts.name];
    db.close();
    cb();
  });

  // Closing and re-opening the DB re-generates native indexes
  api._freshen = function () {
    return new Promise(function (resolve) {
      api._close(function () {
        $(resolve)();
      });
    });
  };

  // TODO: this setTimeout seems nasty, if its needed lets
  // figure out / explain why
  setTimeout(function () {
    callback(null, api);
  });
}

// TODO: this isnt really valid permanently, just being lazy to start
IdbPouch.valid = function () {
  return true;
};

function index (PouchDB) {
  PouchDB.adapter(ADAPTER_NAME, IdbPouch, true);
}

module.exports = index;
