"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.MongoStorageAdapter = void 0;
var _mongodbUrl = require("../../../vendor/mongodbUrl");
var _StorageAdapter = require("../StorageAdapter");
var _Utils = _interopRequireDefault(require("../../../Utils"));
var _MongoCollection = _interopRequireDefault(require("./MongoCollection"));
var _MongoSchemaCollection = _interopRequireDefault(require("./MongoSchemaCollection"));
var _MongoTransform = require("./MongoTransform");
var _node = _interopRequireDefault(require("parse/node"));
var _lodash = _interopRequireDefault(require("lodash"));
var _bson = require("bson");
var _defaults = _interopRequireWildcard(require("../../../defaults"));
var _logger = _interopRequireDefault(require("../../../logger"));
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// -disable-next
// -disable-next
// -disable-next
const mongodb = require('mongodb');
const MongoClient = mongodb.MongoClient;
const ReadPreference = mongodb.ReadPreference;
const MongoSchemaCollectionName = '_SCHEMA';

/**
 * Determines if a MongoDB error is a transient infrastructure error
 * (connection pool, network, server selection) as opposed to a query-level error.
 */
function isTransientError(error) {
  if (!error) {
    return false;
  }

  // Connection pool, network, and server selection errors
  const transientErrorNames = ['MongoWaitQueueTimeoutError', 'MongoServerSelectionError', 'MongoNetworkTimeoutError', 'MongoNetworkError'];
  if (transientErrorNames.includes(error.name)) {
    return true;
  }

  // Check for MongoDB's transient transaction error label
  if (typeof error.hasErrorLabel === 'function') {
    if (error.hasErrorLabel('TransientTransactionError')) {
      return true;
    }
  }
  return false;
}
const storageAdapterAllCollections = mongoAdapter => {
  return mongoAdapter.connect().then(() => mongoAdapter.database.collections()).then(collections => {
    return collections.filter(collection => {
      if (collection.namespace.match(/\.system\./)) {
        return false;
      }
      // TODO: If you have one app with a collection prefix that happens to be a prefix of another
      // apps prefix, this will go very very badly. We should fix that somehow.
      return collection.collectionName.indexOf(mongoAdapter._collectionPrefix) == 0;
    });
  });
};
const convertParseSchemaToMongoSchema = ({
  ...schema
}) => {
  delete schema.fields._rperm;
  delete schema.fields._wperm;
  if (schema.className === '_User') {
    // Legacy mongo adapter knows about the difference between password and _hashed_password.
    // Future database adapters will only know about _hashed_password.
    // Note: Parse Server will bring back password with injectDefaultSchema, so we don't need
    // to add _hashed_password back ever.
    delete schema.fields._hashed_password;
  }
  return schema;
};

// Returns { code, error } if invalid, or { result }, an object
// suitable for inserting into _SCHEMA collection, otherwise.
const mongoSchemaFromFieldsAndClassNameAndCLP = (fields, className, classLevelPermissions, indexes) => {
  const mongoObject = {
    _id: className,
    objectId: 'string',
    updatedAt: 'string',
    createdAt: 'string',
    _metadata: undefined
  };
  for (const fieldName in fields) {
    const {
      type,
      targetClass,
      ...fieldOptions
    } = fields[fieldName];
    mongoObject[fieldName] = _MongoSchemaCollection.default.parseFieldTypeToMongoFieldType({
      type,
      targetClass
    });
    if (fieldOptions && Object.keys(fieldOptions).length > 0) {
      mongoObject._metadata = mongoObject._metadata || {};
      mongoObject._metadata.fields_options = mongoObject._metadata.fields_options || {};
      mongoObject._metadata.fields_options[fieldName] = fieldOptions;
    }
  }
  if (typeof classLevelPermissions !== 'undefined') {
    mongoObject._metadata = mongoObject._metadata || {};
    if (!classLevelPermissions) {
      delete mongoObject._metadata.class_permissions;
    } else {
      mongoObject._metadata.class_permissions = classLevelPermissions;
    }
  }
  if (indexes && typeof indexes === 'object' && Object.keys(indexes).length > 0) {
    mongoObject._metadata = mongoObject._metadata || {};
    mongoObject._metadata.indexes = indexes;
  }
  if (!mongoObject._metadata) {
    // cleanup the unused _metadata
    delete mongoObject._metadata;
  }
  return mongoObject;
};
function validateExplainValue(explain) {
  if (explain) {
    // The list of allowed explain values is from node-mongodb-native/lib/explain.js
    const explainAllowedValues = ['queryPlanner', 'queryPlannerExtended', 'executionStats', 'allPlansExecution', false, true];
    if (!explainAllowedValues.includes(explain)) {
      throw new _node.default.Error(_node.default.Error.INVALID_QUERY, 'Invalid value for explain');
    }
  }
}
class MongoStorageAdapter {
  // Private

  // Public

  constructor({
    uri = _defaults.default.DefaultMongoURI,
    collectionPrefix = '',
    mongoOptions = {}
  }) {
    this._uri = uri;
    this._collectionPrefix = collectionPrefix;
    this._onchange = () => {};

    // MaxTimeMS is not a global MongoDB client option, it is applied per operation.
    this._maxTimeMS = mongoOptions.maxTimeMS;
    // BatchSize is not a global MongoDB client option, it is applied per cursor operation.
    this._batchSize = mongoOptions.batchSize;
    this.canSortOnJoinTables = true;
    this.enableSchemaHooks = !!mongoOptions.enableSchemaHooks;
    this.schemaCacheTtl = mongoOptions.schemaCacheTtl;
    this.disableIndexFieldValidation = !!mongoOptions.disableIndexFieldValidation;
    this._logClientEvents = mongoOptions.logClientEvents;
    this._clientMetadata = mongoOptions.clientMetadata;

    // Create a copy of mongoOptions and remove Parse Server-specific options that should not
    // be passed to MongoDB client. Note: We only delete from this._mongoOptions, not from the
    // original mongoOptions object, because other components (like DatabaseController) need
    // access to these options.
    this._mongoOptions = {
      ...mongoOptions
    };
    for (const key of _defaults.ParseServerDatabaseOptions) {
      delete this._mongoOptions[key];
    }
  }
  watch(callback) {
    this._onchange = callback;
  }
  connect() {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    // parsing and re-formatting causes the auth value (if there) to get URI
    // encoded
    const encodedUri = (0, _mongodbUrl.format)((0, _mongodbUrl.parse)(this._uri));

    // Only use driverInfo if clientMetadata option is set
    const options = {
      ...this._mongoOptions
    };
    if (this._clientMetadata) {
      options.driverInfo = {
        name: this._clientMetadata.name,
        version: this._clientMetadata.version
      };
    }
    this.connectionPromise = MongoClient.connect(encodedUri, options).then(client => {
      // Starting mongoDB 3.0, the MongoClient.connect don't return a DB anymore but a client
      // Fortunately, we can get back the options and use them to select the proper DB.
      // https://github.com/mongodb/node-mongodb-native/blob/2c35d76f08574225b8db02d7bef687123e6bb018/lib/mongo_client.js#L885
      const options = client.s.options;
      const database = client.db(options.dbName);
      if (!database) {
        delete this.connectionPromise;
        return;
      }
      client.on('error', () => {
        delete this.connectionPromise;
      });
      client.on('close', () => {
        delete this.connectionPromise;
      });

      // Set up client event logging if configured
      if (this._logClientEvents && Array.isArray(this._logClientEvents)) {
        this._logClientEvents.forEach(eventConfig => {
          client.on(eventConfig.name, event => {
            let logData = {};
            if (!eventConfig.keys || eventConfig.keys.length === 0) {
              logData = event;
            } else {
              eventConfig.keys.forEach(keyPath => {
                logData[keyPath] = _lodash.default.get(event, keyPath);
              });
            }

            // Validate log level exists, fallback to 'info'
            const logLevel = typeof _logger.default[eventConfig.logLevel] === 'function' ? eventConfig.logLevel : 'info';

            // Safe JSON serialization with Map/Set and circular reference support
            const logMessage = `MongoDB client event ${eventConfig.name}: ${JSON.stringify(logData, _Utils.default.getCircularReplacer())}`;
            _logger.default[logLevel](logMessage);
          });
        });
      }
      this.client = client;
      this.database = database;
    }).catch(err => {
      delete this.connectionPromise;
      return Promise.reject(err);
    });
    return this.connectionPromise;
  }
  handleError(error) {
    if (error && error.code === 13) {
      // Unauthorized error
      delete this.client;
      delete this.database;
      delete this.connectionPromise;
      _logger.default.error('Received unauthorized error', {
        error: error
      });
    }

    // Transform infrastructure/transient errors into Parse.Error.INTERNAL_SERVER_ERROR
    if (isTransientError(error)) {
      _logger.default.error('Database transient error', error);
      throw new _node.default.Error(_node.default.Error.INTERNAL_SERVER_ERROR, 'Database error');
    }
    throw error;
  }
  async handleShutdown() {
    if (!this.client) {
      return;
    }
    await this.client.close(false);
    delete this.connectionPromise;
  }
  _adaptiveCollection(name) {
    return this.connect().then(() => this.database.collection(this._collectionPrefix + name)).then(rawCollection => new _MongoCollection.default(rawCollection)).catch(err => this.handleError(err));
  }
  _schemaCollection() {
    return this.connect().then(() => this._adaptiveCollection(MongoSchemaCollectionName)).then(collection => {
      if (!this._stream && this.enableSchemaHooks) {
        this._stream = collection._mongoCollection.watch();
        this._stream.on('change', () => this._onchange());
      }
      return new _MongoSchemaCollection.default(collection);
    });
  }
  classExists(name) {
    return this.connect().then(() => {
      return this.database.listCollections({
        name: this._collectionPrefix + name
      }).toArray();
    }).then(collections => {
      return collections.length > 0;
    }).catch(err => this.handleError(err));
  }
  setClassLevelPermissions(className, CLPs) {
    return this._schemaCollection().then(schemaCollection => schemaCollection.updateSchema(className, {
      $set: {
        '_metadata.class_permissions': CLPs
      }
    })).catch(err => this.handleError(err));
  }
  setIndexesWithSchemaFormat(className, submittedIndexes, existingIndexes = {}, fields) {
    if (submittedIndexes === undefined) {
      return Promise.resolve();
    }
    if (Object.keys(existingIndexes).length === 0) {
      existingIndexes = {
        _id_: {
          _id: 1
        }
      };
    }
    const deletePromises = [];
    const insertedIndexes = [];
    Object.keys(submittedIndexes).forEach(name => {
      const field = submittedIndexes[name];
      if (existingIndexes[name] && field.__op !== 'Delete') {
        throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `Index ${name} exists, cannot update.`);
      }
      if (!existingIndexes[name] && field.__op === 'Delete') {
        throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `Index ${name} does not exist, cannot delete.`);
      }
      if (field.__op === 'Delete') {
        const promise = this.dropIndex(className, name);
        deletePromises.push(promise);
        delete existingIndexes[name];
      } else {
        Object.keys(field).forEach(key => {
          if (!this.disableIndexFieldValidation && !Object.prototype.hasOwnProperty.call(fields, key.indexOf('_p_') === 0 ? key.replace('_p_', '') : key)) {
            throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `Field ${key} does not exist, cannot add index.`);
          }
        });
        existingIndexes[name] = field;
        insertedIndexes.push({
          key: field,
          name
        });
      }
    });
    let insertPromise = Promise.resolve();
    if (insertedIndexes.length > 0) {
      insertPromise = this.createIndexes(className, insertedIndexes);
    }
    return Promise.all(deletePromises).then(() => insertPromise).then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.updateSchema(className, {
      $set: {
        '_metadata.indexes': existingIndexes
      }
    })).catch(err => this.handleError(err));
  }
  setIndexesFromMongo(className) {
    return this.getIndexes(className).then(indexes => {
      indexes = indexes.reduce((obj, index) => {
        if (index.key._fts) {
          delete index.key._fts;
          delete index.key._ftsx;
          for (const field in index.weights) {
            index.key[field] = 'text';
          }
        }
        obj[index.name] = index.key;
        return obj;
      }, {});
      return this._schemaCollection().then(schemaCollection => schemaCollection.updateSchema(className, {
        $set: {
          '_metadata.indexes': indexes
        }
      }));
    }).catch(err => this.handleError(err)).catch(() => {
      // Ignore if collection not found
      return Promise.resolve();
    });
  }
  createClass(className, schema) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoObject = mongoSchemaFromFieldsAndClassNameAndCLP(schema.fields, className, schema.classLevelPermissions, schema.indexes);
    mongoObject._id = className;
    return this.setIndexesWithSchemaFormat(className, schema.indexes, {}, schema.fields).then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.insertSchema(mongoObject)).catch(err => this.handleError(err));
  }
  async updateFieldOptions(className, fieldName, type) {
    const schemaCollection = await this._schemaCollection();
    await schemaCollection.updateFieldOptions(className, fieldName, type);
  }
  addFieldIfNotExists(className, fieldName, type) {
    return this._schemaCollection().then(schemaCollection => schemaCollection.addFieldIfNotExists(className, fieldName, type)).then(() => this.createIndexesIfNeeded(className, fieldName, type)).catch(err => this.handleError(err));
  }

  // Drops a collection. Resolves with true if it was a Parse Schema (eg. _User, Custom, etc.)
  // and resolves with false if it wasn't (eg. a join table). Rejects if deletion was impossible.
  deleteClass(className) {
    return this._adaptiveCollection(className).then(collection => collection.drop()).catch(error => {
      // 'ns not found' means collection was already gone. Ignore deletion attempt.
      if (error.message == 'ns not found') {
        return;
      }
      throw error;
    })
    // We've dropped the collection, now remove the _SCHEMA document
    .then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.findAndDeleteSchema(className)).catch(err => this.handleError(err));
  }
  deleteAllClasses(fast) {
    return storageAdapterAllCollections(this).then(collections => Promise.all(collections.map(collection => fast ? collection.deleteMany({}) : collection.drop())));
  }

  // Remove the column and all the data. For Relations, the _Join collection is handled
  // specially, this function does not delete _Join columns. It should, however, indicate
  // that the relation fields does not exist anymore. In mongo, this means removing it from
  // the _SCHEMA collection.  There should be no actual data in the collection under the same name
  // as the relation column, so it's fine to attempt to delete it. If the fields listed to be
  // deleted do not exist, this function should return successfully anyways. Checking for
  // attempts to delete non-existent fields is the responsibility of Parse Server.

  // Pointer field names are passed for legacy reasons: the original mongo
  // format stored pointer field names differently in the database, and therefore
  // needed to know the type of the field before it could delete it. Future database
  // adapters should ignore the pointerFieldNames argument. All the field names are in
  // fieldNames, they show up additionally in the pointerFieldNames database for use
  // by the mongo adapter, which deals with the legacy mongo format.

  // This function is not obligated to delete fields atomically. It is given the field
  // names in a list so that databases that are capable of deleting fields atomically
  // may do so.

  // Returns a Promise.
  deleteFields(className, schema, fieldNames) {
    const mongoFormatNames = fieldNames.map(fieldName => {
      if (schema.fields[fieldName].type === 'Pointer') {
        return `_p_${fieldName}`;
      } else {
        return fieldName;
      }
    });
    const collectionUpdate = {
      $unset: {}
    };
    mongoFormatNames.forEach(name => {
      collectionUpdate['$unset'][name] = null;
    });
    const collectionFilter = {
      $or: []
    };
    mongoFormatNames.forEach(name => {
      collectionFilter['$or'].push({
        [name]: {
          $exists: true
        }
      });
    });
    const schemaUpdate = {
      $unset: {}
    };
    fieldNames.forEach(name => {
      schemaUpdate['$unset'][name] = null;
      schemaUpdate['$unset'][`_metadata.fields_options.${name}`] = null;
    });
    return this._adaptiveCollection(className).then(collection => collection.updateMany(collectionFilter, collectionUpdate)).then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.updateSchema(className, schemaUpdate)).catch(err => this.handleError(err));
  }

  // Return a promise for all schemas known to this adapter, in Parse format. In case the
  // schemas cannot be retrieved, returns a promise that rejects. Requirements for the
  // rejection reason are TBD.
  getAllClasses() {
    return this._schemaCollection().then(schemasCollection => schemasCollection._fetchAllSchemasFrom_SCHEMA()).catch(err => this.handleError(err));
  }

  // Return a promise for the schema with the given name, in Parse format. If
  // this adapter doesn't know about the schema, return a promise that rejects with
  // undefined as the reason.
  getClass(className) {
    return this._schemaCollection().then(schemasCollection => schemasCollection._fetchOneSchemaFrom_SCHEMA(className)).catch(err => this.handleError(err));
  }

  // TODO: As yet not particularly well specified. Creates an object. Maybe shouldn't even need the schema,
  // and should infer from the type. Or maybe does need the schema for validations. Or maybe needs
  // the schema only for the legacy mongo format. We'll figure that out later.
  createObject(className, schema, object, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoObject = (0, _MongoTransform.parseObjectToMongoObjectForCreate)(className, object, schema);
    return this._adaptiveCollection(className).then(collection => collection.insertOne(mongoObject, transactionalSession)).then(() => ({
      ops: [mongoObject]
    })).catch(error => {
      if (error.code === 11000) {
        _logger.default.error('Duplicate key error:', error.message);
        const err = new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
        err.underlyingError = error;
        if (error.message) {
          const matches = error.message.match(/index:[\sa-zA-Z0-9_\-\.]+\$?([a-zA-Z_-]+)_1/);
          if (matches && Array.isArray(matches)) {
            err.userInfo = {
              duplicated_field: matches[1]
            };
          }
          // Check for authData unique index violations
          if (!err.userInfo) {
            const authDataMatch = error.message.match(/index:\s+(_auth_data_[a-zA-Z0-9_]+_id)/);
            if (authDataMatch) {
              err.userInfo = {
                duplicated_field: authDataMatch[1]
              };
            }
          }
        }
        throw err;
      }
      throw error;
    }).catch(err => this.handleError(err));
  }
  createObjects(className, schema, objects, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoObjects = objects.map(object => (0, _MongoTransform.parseObjectToMongoObjectForCreate)(className, object, schema));
    return this._adaptiveCollection(className).then(collection => collection.insertMany(mongoObjects, transactionalSession)).catch(error => {
      if (error.code === 11000) {
        _logger.default.error('Duplicate key error:', error.message);
        const err = new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
        err.underlyingError = error;
        if (error.message) {
          const matches = error.message.match(/index:[\sa-zA-Z0-9_\-\.]+\$?([a-zA-Z_-]+)_1/);
          if (matches && Array.isArray(matches)) {
            err.userInfo = {
              duplicated_field: matches[1]
            };
          }
          if (!err.userInfo) {
            const authDataMatch = error.message.match(/index:\s+(_auth_data_[a-zA-Z0-9_]+_id)/);
            if (authDataMatch) {
              err.userInfo = {
                duplicated_field: authDataMatch[1]
              };
            }
          }
        }
        throw err;
      }
      throw error;
    }).catch(err => this.handleError(err));
  }

  // Remove all objects that match the given Parse Query.
  // If no objects match, reject with OBJECT_NOT_FOUND. If objects are found and deleted, resolve with undefined.
  // If there is some other error, reject with INTERNAL_SERVER_ERROR.
  deleteObjectsByQuery(className, schema, query, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    return this._adaptiveCollection(className).then(collection => {
      const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
      return collection.deleteMany(mongoWhere, transactionalSession);
    }).catch(err => this.handleError(err)).then(({
      deletedCount
    }) => {
      if (deletedCount === 0) {
        throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Object not found.');
      }
      return Promise.resolve();
    }, () => {
      throw new _node.default.Error(_node.default.Error.INTERNAL_SERVER_ERROR, 'Database adapter error');
    });
  }

  // Apply the update to all objects that match the given Parse Query.
  updateObjectsByQuery(className, schema, query, update, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoUpdate = (0, _MongoTransform.transformUpdate)(className, update, schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    return this._adaptiveCollection(className).then(collection => collection.updateMany(mongoWhere, mongoUpdate, transactionalSession)).catch(err => this.handleError(err));
  }

  // Atomically finds and updates an object based on query.
  // Return value not currently well specified.
  findOneAndUpdate(className, schema, query, update, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoUpdate = (0, _MongoTransform.transformUpdate)(className, update, schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.findOneAndUpdate(mongoWhere, mongoUpdate, {
      returnDocument: 'after',
      session: transactionalSession || undefined
    })).then(result => (0, _MongoTransform.mongoObjectToParseObject)(className, result, schema)).catch(error => {
      if (error.code === 11000) {
        _logger.default.error('Duplicate key error:', error.message);
        const err = new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
        err.underlyingError = error;
        if (error.message) {
          const matches = error.message.match(/index:[\sa-zA-Z0-9_\-\.]+\$?([a-zA-Z_-]+)_1/);
          if (matches && Array.isArray(matches)) {
            err.userInfo = {
              duplicated_field: matches[1]
            };
          }
          if (!err.userInfo) {
            const authDataMatch = error.message.match(/index:\s+(_auth_data_[a-zA-Z0-9_]+_id)/);
            if (authDataMatch) {
              err.userInfo = {
                duplicated_field: authDataMatch[1]
              };
            }
          }
        }
        throw err;
      }
      throw error;
    }).catch(err => this.handleError(err));
  }
  updateObjectsByBulk(className, schema, operations, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    const bulks = operations.map(({
      updateOne,
      updateMany,
      insertOne
    }) => {
      if (updateOne) {
        return {
          updateOne: {
            filter: (0, _MongoTransform.transformWhere)(className, updateOne.filter, schema),
            update: (0, _MongoTransform.transformUpdate)(className, updateOne.update, schema),
            upsert: false
          }
        };
      }
      if (updateMany) {
        return {
          updateMany: {
            filter: (0, _MongoTransform.transformWhere)(className, updateMany.filter, schema),
            update: (0, _MongoTransform.transformUpdate)(className, updateMany.update, schema),
            upsert: false
          }
        };
      }
      return {
        insertOne: {
          document: (0, _MongoTransform.parseObjectToMongoObjectForCreate)(className, insertOne.document, schema)
        }
      };
    });
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.bulkWrite(bulks, {
      session: transactionalSession || undefined,
      ordered: false,
      bypassDocumentValidation: true,
      writeConcern: {
        w: 1,
        j: false
      }
    })).catch(error => {
      if (error.code === 11000) {
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
      }
      throw error;
    }).catch(err => this.handleError(err));
  }

  // Hopefully we can get rid of this. It's only used for config and hooks.
  upsertOneObject(className, schema, query, update, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoUpdate = (0, _MongoTransform.transformUpdate)(className, update, schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    return this._adaptiveCollection(className).then(collection => collection.upsertOne(mongoWhere, mongoUpdate, transactionalSession)).catch(err => this.handleError(err));
  }

  // Executes a find. Accepts: className, query in Parse format, and { skip, limit, sort }.
  find(className, schema, query, {
    skip,
    limit,
    sort,
    keys,
    readPreference,
    hint,
    caseInsensitive,
    explain,
    comment
  }) {
    validateExplainValue(explain);
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    const mongoSort = _lodash.default.mapKeys(sort, (value, fieldName) => (0, _MongoTransform.transformKey)(className, fieldName, schema));
    const mongoKeys = _lodash.default.reduce(keys, (memo, key) => {
      if (key === 'ACL') {
        memo['_rperm'] = 1;
        memo['_wperm'] = 1;
      } else {
        memo[(0, _MongoTransform.transformKey)(className, key, schema)] = 1;
      }
      return memo;
    }, {});

    // If we aren't requesting the `_id` field, we need to explicitly opt out
    // of it. Doing so in parse-server is unusual, but it can allow us to
    // optimize some queries with covering indexes.
    if (keys && !mongoKeys._id) {
      mongoKeys._id = 0;
    }
    readPreference = this._parseReadPreference(readPreference);
    return this.createTextIndexesIfNeeded(className, query, schema).then(() => this._adaptiveCollection(className)).then(collection => collection.find(mongoWhere, {
      skip,
      limit,
      sort: mongoSort,
      keys: mongoKeys,
      maxTimeMS: this._maxTimeMS,
      batchSize: this._batchSize,
      readPreference,
      hint,
      caseInsensitive,
      explain,
      comment
    })).then(objects => {
      if (explain) {
        return objects;
      }
      return objects.map(object => (0, _MongoTransform.mongoObjectToParseObject)(className, object, schema));
    }).catch(err => this.handleError(err));
  }
  ensureIndex(className, schema, fieldNames, indexName, caseInsensitive = false, options = {}) {
    schema = convertParseSchemaToMongoSchema(schema);
    const indexCreationRequest = {};
    const mongoFieldNames = fieldNames.map(fieldName => (0, _MongoTransform.transformKey)(className, fieldName, schema));
    mongoFieldNames.forEach(fieldName => {
      indexCreationRequest[fieldName] = options.indexType !== undefined ? options.indexType : 1;
    });
    const defaultOptions = {
      background: true,
      sparse: true
    };
    const indexNameOptions = indexName ? {
      name: indexName
    } : {};
    const ttlOptions = options.ttl !== undefined ? {
      expireAfterSeconds: options.ttl
    } : {};
    const sparseOptions = options.sparse !== undefined ? {
      sparse: options.sparse
    } : {};
    const caseInsensitiveOptions = caseInsensitive ? {
      collation: _MongoCollection.default.caseInsensitiveCollation()
    } : {};
    const partialFilterOptions = options.partialFilterExpression !== undefined ? {
      partialFilterExpression: options.partialFilterExpression
    } : {};
    const indexOptions = {
      ...defaultOptions,
      ...caseInsensitiveOptions,
      ...indexNameOptions,
      ...ttlOptions,
      ...sparseOptions,
      ...partialFilterOptions
    };
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.createIndex(indexCreationRequest, indexOptions)).catch(err => this.handleError(err));
  }

  // Create a unique index. Unique indexes on nullable fields are not allowed. Since we don't
  // currently know which fields are nullable and which aren't, we ignore that criteria.
  // As such, we shouldn't expose this function to users of parse until we have an out-of-band
  // Way of determining if a field is nullable. Undefined doesn't count against uniqueness,
  // which is why we use sparse indexes.
  ensureUniqueness(className, schema, fieldNames) {
    schema = convertParseSchemaToMongoSchema(schema);
    const indexCreationRequest = {};
    const mongoFieldNames = fieldNames.map(fieldName => (0, _MongoTransform.transformKey)(className, fieldName, schema));
    mongoFieldNames.forEach(fieldName => {
      indexCreationRequest[fieldName] = 1;
    });
    return this._adaptiveCollection(className).then(collection => collection._ensureSparseUniqueIndexInBackground(indexCreationRequest)).catch(error => {
      if (error.code === 11000) {
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'Tried to ensure field uniqueness for a class that already has duplicates.');
      }
      throw error;
    }).catch(err => this.handleError(err));
  }

  // Creates a unique sparse index on _auth_data_<provider>.id to prevent
  // race conditions during concurrent signups with the same authData.
  ensureAuthDataUniqueness(provider) {
    return this._adaptiveCollection('_User').then(collection => collection._mongoCollection.createIndex({
      [`_auth_data_${provider}.id`]: 1
    }, {
      unique: true,
      sparse: true,
      background: true,
      name: `_auth_data_${provider}_id`
    })).catch(error => {
      if (error.code === 11000) {
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'Tried to ensure field uniqueness for a class that already has duplicates.');
      }
      // Ignore "index already exists with same name" or "index already exists with different options"
      if (error.code === 85 || error.code === 86) {
        return;
      }
      throw error;
    }).catch(err => this.handleError(err));
  }

  // Used in tests
  _rawFind(className, query) {
    return this._adaptiveCollection(className).then(collection => collection.find(query, {
      maxTimeMS: this._maxTimeMS,
      batchSize: this._batchSize
    })).catch(err => this.handleError(err));
  }

  // Executes a count.
  count(className, schema, query, readPreference, _estimate, hint, comment) {
    schema = convertParseSchemaToMongoSchema(schema);
    readPreference = this._parseReadPreference(readPreference);
    return this._adaptiveCollection(className).then(collection => collection.count((0, _MongoTransform.transformWhere)(className, query, schema, true), {
      maxTimeMS: this._maxTimeMS,
      readPreference,
      hint,
      comment
    })).catch(err => this.handleError(err));
  }
  distinct(className, schema, query, fieldName) {
    schema = convertParseSchemaToMongoSchema(schema);
    const isPointerField = schema.fields[fieldName] && schema.fields[fieldName].type === 'Pointer';
    const transformField = (0, _MongoTransform.transformKey)(className, fieldName, schema);
    return this._adaptiveCollection(className).then(collection => collection.distinct(transformField, (0, _MongoTransform.transformWhere)(className, query, schema))).then(objects => {
      objects = objects.filter(obj => obj != null);
      return objects.map(object => {
        if (isPointerField) {
          return (0, _MongoTransform.transformPointerString)(schema, fieldName, object);
        }
        return (0, _MongoTransform.mongoObjectToParseObject)(className, object, schema);
      });
    }).catch(err => this.handleError(err));
  }
  aggregate(className, schema, pipeline, readPreference, hint, explain, comment, rawValues, rawFieldNames) {
    validateExplainValue(explain);
    if (rawValues) {
      pipeline = _bson.EJSON.deserialize(pipeline);
    }
    let isPointerField = false;
    pipeline = pipeline.map(stage => {
      if (stage.$group) {
        stage.$group = this._parseAggregateGroupArgs(schema, stage.$group, rawFieldNames);
        if (stage.$group._id && typeof stage.$group._id === 'string' && stage.$group._id.indexOf('$_p_') >= 0) {
          isPointerField = true;
        }
      }
      if (stage.$match) {
        stage.$match = this._parseAggregateArgs(schema, stage.$match, rawValues, rawFieldNames);
      }
      if (stage.$project) {
        stage.$project = this._parseAggregateProjectArgs(schema, stage.$project, rawValues, rawFieldNames);
      }
      if (stage.$geoNear && stage.$geoNear.query) {
        stage.$geoNear.query = this._parseAggregateArgs(schema, stage.$geoNear.query, rawValues, rawFieldNames);
      }
      return stage;
    });
    readPreference = this._parseReadPreference(readPreference);
    return this._adaptiveCollection(className).then(collection => collection.aggregate(pipeline, {
      readPreference,
      maxTimeMS: this._maxTimeMS,
      batchSize: this._batchSize,
      hint,
      explain,
      comment
    })).then(results => {
      if (rawFieldNames) {
        return results;
      }
      results.forEach(result => {
        if (Object.prototype.hasOwnProperty.call(result, '_id')) {
          if (isPointerField && result._id) {
            result._id = result._id.split('$')[1];
          }
          if (result._id == null || result._id == undefined || ['object', 'string'].includes(typeof result._id) && _lodash.default.isEmpty(result._id)) {
            result._id = null;
          }
          result.objectId = result._id;
          delete result._id;
        }
      });
      return results;
    }).then(objects => {
      if (rawValues) {
        return objects.map(obj => _bson.EJSON.serialize(obj));
      }
      if (rawFieldNames) {
        return objects;
      }
      return objects.map(object => (0, _MongoTransform.mongoObjectToParseObject)(className, object, schema));
    }).catch(err => this.handleError(err));
  }

  // This function will recursively traverse the pipeline and convert any Pointer columns.
  // If we detect a pointer column we will rename the column being queried for to match the column
  // in the database. We also modify the value to what we expect the value to be in the database
  // as well.
  // For dates, the driver expects a Date object, but we have a string coming in. So we'll convert
  // the string to a Date so the driver can perform the necessary comparison.
  //
  // The goal of this method is to look for the "leaves" of the pipeline and determine if it needs
  // to be converted. The pipeline can have a few different forms. For more details, see:
  //     https://docs.mongodb.com/manual/reference/operator/aggregation/
  //
  // If the pipeline is an array, it means we are probably parsing an '$and' or '$or' operator. In
  // that case we need to loop through all of it's children to find the columns being operated on.
  // If the pipeline is an object, then we'll loop through the keys checking to see if the key name
  // matches one of the schema columns. If it does match a Pointer column, then we'll convert the
  // value as described above. Date values are left untouched to avoid corrupting native MongoDB
  // aggregation expressions.
  //
  // As much as I hate recursion...this seemed like a good fit for it. We're essentially traversing
  // down a tree to find a "leaf node" and checking to see if it needs to be converted.
  _parseAggregateArgs(schema, pipeline, rawValues, rawFieldNames) {
    if (pipeline === null) {
      return null;
    } else if (_Utils.default.isDate(pipeline)) {
      return pipeline;
    } else if (Array.isArray(pipeline)) {
      return pipeline.map(value => this._parseAggregateArgs(schema, value, rawValues, rawFieldNames));
    } else if (typeof pipeline === 'object') {
      const returnValue = {};
      for (const field in pipeline) {
        if (!rawFieldNames && schema.fields[field] && schema.fields[field].type === 'Pointer') {
          if (typeof pipeline[field] === 'object') {
            returnValue[`_p_${field}`] = pipeline[field];
          } else if (rawValues) {
            returnValue[`_p_${field}`] = pipeline[field];
          } else {
            returnValue[`_p_${field}`] = `${schema.fields[field].targetClass}$${pipeline[field]}`;
          }
        } else {
          returnValue[field] = this._parseAggregateArgs(schema, pipeline[field], rawValues, rawFieldNames);
        }
        if (!rawFieldNames) {
          if (field === 'objectId') {
            returnValue['_id'] = returnValue[field];
            delete returnValue[field];
          } else if (field === 'createdAt') {
            returnValue['_created_at'] = returnValue[field];
            delete returnValue[field];
          } else if (field === 'updatedAt') {
            returnValue['_updated_at'] = returnValue[field];
            delete returnValue[field];
          }
        }
      }
      return returnValue;
    }
    return pipeline;
  }

  // This function is slightly different than the one above. Rather than trying to combine these
  // two functions and making the code even harder to understand, I decided to split it up. The
  // difference with this function is we are not transforming the values, only the keys of the
  // pipeline.
  _parseAggregateProjectArgs(schema, pipeline, rawValues, rawFieldNames) {
    const returnValue = {};
    for (const field in pipeline) {
      if (!rawFieldNames && schema.fields[field] && schema.fields[field].type === 'Pointer') {
        returnValue[`_p_${field}`] = pipeline[field];
      } else {
        returnValue[field] = this._parseAggregateArgs(schema, pipeline[field], rawValues, rawFieldNames);
      }
      if (!rawFieldNames) {
        if (field === 'objectId') {
          returnValue['_id'] = returnValue[field];
          delete returnValue[field];
        } else if (field === 'createdAt') {
          returnValue['_created_at'] = returnValue[field];
          delete returnValue[field];
        } else if (field === 'updatedAt') {
          returnValue['_updated_at'] = returnValue[field];
          delete returnValue[field];
        }
      }
    }
    return returnValue;
  }

  // This function is slightly different than the two above. MongoDB $group aggregate looks like:
  //     { $group: { _id: <expression>, <field1>: { <accumulator1> : <expression1> }, ... } }
  // The <expression> could be a column name, prefixed with the '$' character. We'll look for
  // these <expression> and check to see if it is a 'Pointer' or if it's one of createdAt,
  // updatedAt or objectId and change it accordingly.
  _parseAggregateGroupArgs(schema, pipeline, rawFieldNames) {
    if (Array.isArray(pipeline)) {
      return pipeline.map(value => this._parseAggregateGroupArgs(schema, value, rawFieldNames));
    } else if (typeof pipeline === 'object') {
      const returnValue = {};
      for (const field in pipeline) {
        returnValue[field] = this._parseAggregateGroupArgs(schema, pipeline[field], rawFieldNames);
      }
      return returnValue;
    } else if (typeof pipeline === 'string' && !rawFieldNames) {
      const field = pipeline.substring(1);
      if (schema.fields[field] && schema.fields[field].type === 'Pointer') {
        return `$_p_${field}`;
      } else if (field == 'createdAt') {
        return '$_created_at';
      } else if (field == 'updatedAt') {
        return '$_updated_at';
      }
    }
    return pipeline;
  }

  /**
   * Recursively converts values to Date objects. Since the passed object is part of an aggregation
   * pipeline and can contain various logic operators (like $gt, $lt, etc), this function will
   * traverse the object and convert any strings that can be parsed as dates into Date objects.
   * @param {any} value The value to convert.
   * @returns {any} The original value if not convertible to Date, or a Date object if it is.
   */
  _convertToDate(value) {
    if (_Utils.default.isDate(value)) {
      return value;
    }
    if (typeof value === 'string') {
      return isNaN(Date.parse(value)) ? value : new Date(value);
    }
    if (typeof value === 'object') {
      const returnValue = {};
      for (const field in value) {
        returnValue[field] = this._convertToDate(value[field]);
      }
      return returnValue;
    }
    return value;
  }
  _parseReadPreference(readPreference) {
    if (readPreference) {
      readPreference = readPreference.toUpperCase();
    }
    switch (readPreference) {
      case 'PRIMARY':
        readPreference = ReadPreference.PRIMARY;
        break;
      case 'PRIMARY_PREFERRED':
        readPreference = ReadPreference.PRIMARY_PREFERRED;
        break;
      case 'SECONDARY':
        readPreference = ReadPreference.SECONDARY;
        break;
      case 'SECONDARY_PREFERRED':
        readPreference = ReadPreference.SECONDARY_PREFERRED;
        break;
      case 'NEAREST':
        readPreference = ReadPreference.NEAREST;
        break;
      case undefined:
      case null:
      case '':
        break;
      default:
        throw new _node.default.Error(_node.default.Error.INVALID_QUERY, 'Not supported read preference.');
    }
    return readPreference;
  }
  performInitialization() {
    return Promise.resolve();
  }
  createIndex(className, index) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.createIndex(index)).catch(err => this.handleError(err));
  }
  createIndexes(className, indexes) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.createIndexes(indexes)).catch(err => this.handleError(err));
  }
  createIndexesIfNeeded(className, fieldName, type) {
    if (type && type.type === 'Polygon') {
      const index = {
        [fieldName]: '2dsphere'
      };
      return this.createIndex(className, index);
    }
    return Promise.resolve();
  }
  createTextIndexesIfNeeded(className, query, schema) {
    for (const fieldName in query) {
      if (!query[fieldName] || !query[fieldName].$text) {
        continue;
      }
      const existingIndexes = schema.indexes;
      for (const key in existingIndexes) {
        const index = existingIndexes[key];
        if (Object.prototype.hasOwnProperty.call(index, fieldName)) {
          return Promise.resolve();
        }
      }
      const indexName = `${fieldName}_text`;
      const textIndex = {
        [indexName]: {
          [fieldName]: 'text'
        }
      };
      return this.setIndexesWithSchemaFormat(className, textIndex, existingIndexes, schema.fields).catch(error => {
        if (error.code === 85) {
          // Index exist with different options
          return this.setIndexesFromMongo(className);
        }
        throw error;
      });
    }
    return Promise.resolve();
  }
  getIndexes(className) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.indexes()).catch(err => this.handleError(err));
  }
  dropIndex(className, index) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.dropIndex(index)).catch(err => this.handleError(err));
  }
  dropAllIndexes(className) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.dropIndexes()).catch(err => this.handleError(err));
  }
  updateSchemaWithIndexes() {
    return this.getAllClasses().then(classes => {
      const promises = classes.map(schema => {
        return this.setIndexesFromMongo(schema.className);
      });
      return Promise.all(promises);
    }).catch(err => this.handleError(err));
  }
  createTransactionalSession() {
    const transactionalSection = this.client.startSession();
    transactionalSection.startTransaction();
    return Promise.resolve(transactionalSection);
  }
  commitTransactionalSession(transactionalSection) {
    const commit = retries => {
      return transactionalSection.commitTransaction().catch(error => {
        if (error && error.hasErrorLabel('TransientTransactionError') && retries > 0) {
          return commit(retries - 1);
        }
        throw error;
      }).then(() => {
        transactionalSection.endSession();
      });
    };
    return commit(5);
  }
  abortTransactionalSession(transactionalSection) {
    return transactionalSection.abortTransaction().then(() => {
      transactionalSection.endSession();
    });
  }
}
exports.MongoStorageAdapter = MongoStorageAdapter;
var _default = exports.default = MongoStorageAdapter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbW9uZ29kYlVybCIsInJlcXVpcmUiLCJfU3RvcmFnZUFkYXB0ZXIiLCJfVXRpbHMiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwiX01vbmdvQ29sbGVjdGlvbiIsIl9Nb25nb1NjaGVtYUNvbGxlY3Rpb24iLCJfTW9uZ29UcmFuc2Zvcm0iLCJfbm9kZSIsIl9sb2Rhc2giLCJfYnNvbiIsIl9kZWZhdWx0cyIsIl9pbnRlcm9wUmVxdWlyZVdpbGRjYXJkIiwiX2xvZ2dlciIsImUiLCJ0IiwiV2Vha01hcCIsInIiLCJuIiwiX19lc01vZHVsZSIsIm8iLCJpIiwiZiIsIl9fcHJvdG9fXyIsImRlZmF1bHQiLCJoYXMiLCJnZXQiLCJzZXQiLCJoYXNPd25Qcm9wZXJ0eSIsImNhbGwiLCJPYmplY3QiLCJkZWZpbmVQcm9wZXJ0eSIsImdldE93blByb3BlcnR5RGVzY3JpcHRvciIsIm1vbmdvZGIiLCJNb25nb0NsaWVudCIsIlJlYWRQcmVmZXJlbmNlIiwiTW9uZ29TY2hlbWFDb2xsZWN0aW9uTmFtZSIsImlzVHJhbnNpZW50RXJyb3IiLCJlcnJvciIsInRyYW5zaWVudEVycm9yTmFtZXMiLCJpbmNsdWRlcyIsIm5hbWUiLCJoYXNFcnJvckxhYmVsIiwic3RvcmFnZUFkYXB0ZXJBbGxDb2xsZWN0aW9ucyIsIm1vbmdvQWRhcHRlciIsImNvbm5lY3QiLCJ0aGVuIiwiZGF0YWJhc2UiLCJjb2xsZWN0aW9ucyIsImZpbHRlciIsImNvbGxlY3Rpb24iLCJuYW1lc3BhY2UiLCJtYXRjaCIsImNvbGxlY3Rpb25OYW1lIiwiaW5kZXhPZiIsIl9jb2xsZWN0aW9uUHJlZml4IiwiY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYSIsInNjaGVtYSIsImZpZWxkcyIsIl9ycGVybSIsIl93cGVybSIsImNsYXNzTmFtZSIsIl9oYXNoZWRfcGFzc3dvcmQiLCJtb25nb1NjaGVtYUZyb21GaWVsZHNBbmRDbGFzc05hbWVBbmRDTFAiLCJjbGFzc0xldmVsUGVybWlzc2lvbnMiLCJpbmRleGVzIiwibW9uZ29PYmplY3QiLCJfaWQiLCJvYmplY3RJZCIsInVwZGF0ZWRBdCIsImNyZWF0ZWRBdCIsIl9tZXRhZGF0YSIsInVuZGVmaW5lZCIsImZpZWxkTmFtZSIsInR5cGUiLCJ0YXJnZXRDbGFzcyIsImZpZWxkT3B0aW9ucyIsIk1vbmdvU2NoZW1hQ29sbGVjdGlvbiIsInBhcnNlRmllbGRUeXBlVG9Nb25nb0ZpZWxkVHlwZSIsImtleXMiLCJsZW5ndGgiLCJmaWVsZHNfb3B0aW9ucyIsImNsYXNzX3Blcm1pc3Npb25zIiwidmFsaWRhdGVFeHBsYWluVmFsdWUiLCJleHBsYWluIiwiZXhwbGFpbkFsbG93ZWRWYWx1ZXMiLCJQYXJzZSIsIkVycm9yIiwiSU5WQUxJRF9RVUVSWSIsIk1vbmdvU3RvcmFnZUFkYXB0ZXIiLCJjb25zdHJ1Y3RvciIsInVyaSIsImRlZmF1bHRzIiwiRGVmYXVsdE1vbmdvVVJJIiwiY29sbGVjdGlvblByZWZpeCIsIm1vbmdvT3B0aW9ucyIsIl91cmkiLCJfb25jaGFuZ2UiLCJfbWF4VGltZU1TIiwibWF4VGltZU1TIiwiX2JhdGNoU2l6ZSIsImJhdGNoU2l6ZSIsImNhblNvcnRPbkpvaW5UYWJsZXMiLCJlbmFibGVTY2hlbWFIb29rcyIsInNjaGVtYUNhY2hlVHRsIiwiZGlzYWJsZUluZGV4RmllbGRWYWxpZGF0aW9uIiwiX2xvZ0NsaWVudEV2ZW50cyIsImxvZ0NsaWVudEV2ZW50cyIsIl9jbGllbnRNZXRhZGF0YSIsImNsaWVudE1ldGFkYXRhIiwiX21vbmdvT3B0aW9ucyIsImtleSIsIlBhcnNlU2VydmVyRGF0YWJhc2VPcHRpb25zIiwid2F0Y2giLCJjYWxsYmFjayIsImNvbm5lY3Rpb25Qcm9taXNlIiwiZW5jb2RlZFVyaSIsImZvcm1hdFVybCIsInBhcnNlVXJsIiwib3B0aW9ucyIsImRyaXZlckluZm8iLCJ2ZXJzaW9uIiwiY2xpZW50IiwicyIsImRiIiwiZGJOYW1lIiwib24iLCJBcnJheSIsImlzQXJyYXkiLCJmb3JFYWNoIiwiZXZlbnRDb25maWciLCJldmVudCIsImxvZ0RhdGEiLCJrZXlQYXRoIiwiXyIsImxvZ0xldmVsIiwibG9nZ2VyIiwibG9nTWVzc2FnZSIsIkpTT04iLCJzdHJpbmdpZnkiLCJVdGlscyIsImdldENpcmN1bGFyUmVwbGFjZXIiLCJjYXRjaCIsImVyciIsIlByb21pc2UiLCJyZWplY3QiLCJoYW5kbGVFcnJvciIsImNvZGUiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJoYW5kbGVTaHV0ZG93biIsImNsb3NlIiwiX2FkYXB0aXZlQ29sbGVjdGlvbiIsInJhd0NvbGxlY3Rpb24iLCJNb25nb0NvbGxlY3Rpb24iLCJfc2NoZW1hQ29sbGVjdGlvbiIsIl9zdHJlYW0iLCJfbW9uZ29Db2xsZWN0aW9uIiwiY2xhc3NFeGlzdHMiLCJsaXN0Q29sbGVjdGlvbnMiLCJ0b0FycmF5Iiwic2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zIiwiQ0xQcyIsInNjaGVtYUNvbGxlY3Rpb24iLCJ1cGRhdGVTY2hlbWEiLCIkc2V0Iiwic2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQiLCJzdWJtaXR0ZWRJbmRleGVzIiwiZXhpc3RpbmdJbmRleGVzIiwicmVzb2x2ZSIsIl9pZF8iLCJkZWxldGVQcm9taXNlcyIsImluc2VydGVkSW5kZXhlcyIsImZpZWxkIiwiX19vcCIsInByb21pc2UiLCJkcm9wSW5kZXgiLCJwdXNoIiwicHJvdG90eXBlIiwicmVwbGFjZSIsImluc2VydFByb21pc2UiLCJjcmVhdGVJbmRleGVzIiwiYWxsIiwic2V0SW5kZXhlc0Zyb21Nb25nbyIsImdldEluZGV4ZXMiLCJyZWR1Y2UiLCJvYmoiLCJpbmRleCIsIl9mdHMiLCJfZnRzeCIsIndlaWdodHMiLCJjcmVhdGVDbGFzcyIsImluc2VydFNjaGVtYSIsInVwZGF0ZUZpZWxkT3B0aW9ucyIsImFkZEZpZWxkSWZOb3RFeGlzdHMiLCJjcmVhdGVJbmRleGVzSWZOZWVkZWQiLCJkZWxldGVDbGFzcyIsImRyb3AiLCJtZXNzYWdlIiwiZmluZEFuZERlbGV0ZVNjaGVtYSIsImRlbGV0ZUFsbENsYXNzZXMiLCJmYXN0IiwibWFwIiwiZGVsZXRlTWFueSIsImRlbGV0ZUZpZWxkcyIsImZpZWxkTmFtZXMiLCJtb25nb0Zvcm1hdE5hbWVzIiwiY29sbGVjdGlvblVwZGF0ZSIsIiR1bnNldCIsImNvbGxlY3Rpb25GaWx0ZXIiLCIkb3IiLCIkZXhpc3RzIiwic2NoZW1hVXBkYXRlIiwidXBkYXRlTWFueSIsImdldEFsbENsYXNzZXMiLCJzY2hlbWFzQ29sbGVjdGlvbiIsIl9mZXRjaEFsbFNjaGVtYXNGcm9tX1NDSEVNQSIsImdldENsYXNzIiwiX2ZldGNoT25lU2NoZW1hRnJvbV9TQ0hFTUEiLCJjcmVhdGVPYmplY3QiLCJvYmplY3QiLCJ0cmFuc2FjdGlvbmFsU2Vzc2lvbiIsInBhcnNlT2JqZWN0VG9Nb25nb09iamVjdEZvckNyZWF0ZSIsImluc2VydE9uZSIsIm9wcyIsIkRVUExJQ0FURV9WQUxVRSIsInVuZGVybHlpbmdFcnJvciIsIm1hdGNoZXMiLCJ1c2VySW5mbyIsImR1cGxpY2F0ZWRfZmllbGQiLCJhdXRoRGF0YU1hdGNoIiwiY3JlYXRlT2JqZWN0cyIsIm9iamVjdHMiLCJtb25nb09iamVjdHMiLCJpbnNlcnRNYW55IiwiZGVsZXRlT2JqZWN0c0J5UXVlcnkiLCJxdWVyeSIsIm1vbmdvV2hlcmUiLCJ0cmFuc2Zvcm1XaGVyZSIsImRlbGV0ZWRDb3VudCIsIk9CSkVDVF9OT1RfRk9VTkQiLCJ1cGRhdGVPYmplY3RzQnlRdWVyeSIsInVwZGF0ZSIsIm1vbmdvVXBkYXRlIiwidHJhbnNmb3JtVXBkYXRlIiwiZmluZE9uZUFuZFVwZGF0ZSIsInJldHVybkRvY3VtZW50Iiwic2Vzc2lvbiIsInJlc3VsdCIsIm1vbmdvT2JqZWN0VG9QYXJzZU9iamVjdCIsInVwZGF0ZU9iamVjdHNCeUJ1bGsiLCJvcGVyYXRpb25zIiwiYnVsa3MiLCJ1cGRhdGVPbmUiLCJ1cHNlcnQiLCJkb2N1bWVudCIsImJ1bGtXcml0ZSIsIm9yZGVyZWQiLCJieXBhc3NEb2N1bWVudFZhbGlkYXRpb24iLCJ3cml0ZUNvbmNlcm4iLCJ3IiwiaiIsInVwc2VydE9uZU9iamVjdCIsInVwc2VydE9uZSIsImZpbmQiLCJza2lwIiwibGltaXQiLCJzb3J0IiwicmVhZFByZWZlcmVuY2UiLCJoaW50IiwiY2FzZUluc2Vuc2l0aXZlIiwiY29tbWVudCIsIm1vbmdvU29ydCIsIm1hcEtleXMiLCJ2YWx1ZSIsInRyYW5zZm9ybUtleSIsIm1vbmdvS2V5cyIsIm1lbW8iLCJfcGFyc2VSZWFkUHJlZmVyZW5jZSIsImNyZWF0ZVRleHRJbmRleGVzSWZOZWVkZWQiLCJlbnN1cmVJbmRleCIsImluZGV4TmFtZSIsImluZGV4Q3JlYXRpb25SZXF1ZXN0IiwibW9uZ29GaWVsZE5hbWVzIiwiaW5kZXhUeXBlIiwiZGVmYXVsdE9wdGlvbnMiLCJiYWNrZ3JvdW5kIiwic3BhcnNlIiwiaW5kZXhOYW1lT3B0aW9ucyIsInR0bE9wdGlvbnMiLCJ0dGwiLCJleHBpcmVBZnRlclNlY29uZHMiLCJzcGFyc2VPcHRpb25zIiwiY2FzZUluc2Vuc2l0aXZlT3B0aW9ucyIsImNvbGxhdGlvbiIsImNhc2VJbnNlbnNpdGl2ZUNvbGxhdGlvbiIsInBhcnRpYWxGaWx0ZXJPcHRpb25zIiwicGFydGlhbEZpbHRlckV4cHJlc3Npb24iLCJpbmRleE9wdGlvbnMiLCJjcmVhdGVJbmRleCIsImVuc3VyZVVuaXF1ZW5lc3MiLCJfZW5zdXJlU3BhcnNlVW5pcXVlSW5kZXhJbkJhY2tncm91bmQiLCJlbnN1cmVBdXRoRGF0YVVuaXF1ZW5lc3MiLCJwcm92aWRlciIsInVuaXF1ZSIsIl9yYXdGaW5kIiwiY291bnQiLCJfZXN0aW1hdGUiLCJkaXN0aW5jdCIsImlzUG9pbnRlckZpZWxkIiwidHJhbnNmb3JtRmllbGQiLCJ0cmFuc2Zvcm1Qb2ludGVyU3RyaW5nIiwiYWdncmVnYXRlIiwicGlwZWxpbmUiLCJyYXdWYWx1ZXMiLCJyYXdGaWVsZE5hbWVzIiwiRUpTT04iLCJkZXNlcmlhbGl6ZSIsInN0YWdlIiwiJGdyb3VwIiwiX3BhcnNlQWdncmVnYXRlR3JvdXBBcmdzIiwiJG1hdGNoIiwiX3BhcnNlQWdncmVnYXRlQXJncyIsIiRwcm9qZWN0IiwiX3BhcnNlQWdncmVnYXRlUHJvamVjdEFyZ3MiLCIkZ2VvTmVhciIsInJlc3VsdHMiLCJzcGxpdCIsImlzRW1wdHkiLCJzZXJpYWxpemUiLCJpc0RhdGUiLCJyZXR1cm5WYWx1ZSIsInN1YnN0cmluZyIsIl9jb252ZXJ0VG9EYXRlIiwiaXNOYU4iLCJEYXRlIiwicGFyc2UiLCJ0b1VwcGVyQ2FzZSIsIlBSSU1BUlkiLCJQUklNQVJZX1BSRUZFUlJFRCIsIlNFQ09OREFSWSIsIlNFQ09OREFSWV9QUkVGRVJSRUQiLCJORUFSRVNUIiwicGVyZm9ybUluaXRpYWxpemF0aW9uIiwiJHRleHQiLCJ0ZXh0SW5kZXgiLCJkcm9wQWxsSW5kZXhlcyIsImRyb3BJbmRleGVzIiwidXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMiLCJjbGFzc2VzIiwicHJvbWlzZXMiLCJjcmVhdGVUcmFuc2FjdGlvbmFsU2Vzc2lvbiIsInRyYW5zYWN0aW9uYWxTZWN0aW9uIiwic3RhcnRTZXNzaW9uIiwic3RhcnRUcmFuc2FjdGlvbiIsImNvbW1pdFRyYW5zYWN0aW9uYWxTZXNzaW9uIiwiY29tbWl0IiwicmV0cmllcyIsImNvbW1pdFRyYW5zYWN0aW9uIiwiZW5kU2Vzc2lvbiIsImFib3J0VHJhbnNhY3Rpb25hbFNlc3Npb24iLCJhYm9ydFRyYW5zYWN0aW9uIiwiZXhwb3J0cyIsIl9kZWZhdWx0Il0sInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL0FkYXB0ZXJzL1N0b3JhZ2UvTW9uZ28vTW9uZ29TdG9yYWdlQWRhcHRlci5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBAZmxvd1xuaW1wb3J0IHsgZm9ybWF0IGFzIGZvcm1hdFVybCwgcGFyc2UgYXMgcGFyc2VVcmwgfSBmcm9tICcuLi8uLi8uLi92ZW5kb3IvbW9uZ29kYlVybCc7XG5pbXBvcnQgdHlwZSB7IFF1ZXJ5T3B0aW9ucywgUXVlcnlUeXBlLCBTY2hlbWFUeXBlLCBTdG9yYWdlQ2xhc3MgfSBmcm9tICcuLi9TdG9yYWdlQWRhcHRlcic7XG5pbXBvcnQgeyBTdG9yYWdlQWRhcHRlciB9IGZyb20gJy4uL1N0b3JhZ2VBZGFwdGVyJztcbmltcG9ydCBVdGlscyBmcm9tICcuLi8uLi8uLi9VdGlscyc7XG5pbXBvcnQgTW9uZ29Db2xsZWN0aW9uIGZyb20gJy4vTW9uZ29Db2xsZWN0aW9uJztcbmltcG9ydCBNb25nb1NjaGVtYUNvbGxlY3Rpb24gZnJvbSAnLi9Nb25nb1NjaGVtYUNvbGxlY3Rpb24nO1xuaW1wb3J0IHtcbiAgbW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0LFxuICBwYXJzZU9iamVjdFRvTW9uZ29PYmplY3RGb3JDcmVhdGUsXG4gIHRyYW5zZm9ybUtleSxcbiAgdHJhbnNmb3JtUG9pbnRlclN0cmluZyxcbiAgdHJhbnNmb3JtVXBkYXRlLFxuICB0cmFuc2Zvcm1XaGVyZSxcbn0gZnJvbSAnLi9Nb25nb1RyYW5zZm9ybSc7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCBQYXJzZSBmcm9tICdwYXJzZS9ub2RlJztcbi8vIEBmbG93LWRpc2FibGUtbmV4dFxuaW1wb3J0IF8gZnJvbSAnbG9kYXNoJztcbmltcG9ydCB7IEVKU09OIH0gZnJvbSAnYnNvbic7XG5pbXBvcnQgZGVmYXVsdHMsIHsgUGFyc2VTZXJ2ZXJEYXRhYmFzZU9wdGlvbnMgfSBmcm9tICcuLi8uLi8uLi9kZWZhdWx0cyc7XG5pbXBvcnQgbG9nZ2VyIGZyb20gJy4uLy4uLy4uL2xvZ2dlcic7XG5cbi8vIEBmbG93LWRpc2FibGUtbmV4dFxuY29uc3QgbW9uZ29kYiA9IHJlcXVpcmUoJ21vbmdvZGInKTtcbmNvbnN0IE1vbmdvQ2xpZW50ID0gbW9uZ29kYi5Nb25nb0NsaWVudDtcbmNvbnN0IFJlYWRQcmVmZXJlbmNlID0gbW9uZ29kYi5SZWFkUHJlZmVyZW5jZTtcblxuY29uc3QgTW9uZ29TY2hlbWFDb2xsZWN0aW9uTmFtZSA9ICdfU0NIRU1BJztcblxuLyoqXG4gKiBEZXRlcm1pbmVzIGlmIGEgTW9uZ29EQiBlcnJvciBpcyBhIHRyYW5zaWVudCBpbmZyYXN0cnVjdHVyZSBlcnJvclxuICogKGNvbm5lY3Rpb24gcG9vbCwgbmV0d29yaywgc2VydmVyIHNlbGVjdGlvbikgYXMgb3Bwb3NlZCB0byBhIHF1ZXJ5LWxldmVsIGVycm9yLlxuICovXG5mdW5jdGlvbiBpc1RyYW5zaWVudEVycm9yKGVycm9yKSB7XG4gIGlmICghZXJyb3IpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvLyBDb25uZWN0aW9uIHBvb2wsIG5ldHdvcmssIGFuZCBzZXJ2ZXIgc2VsZWN0aW9uIGVycm9yc1xuICBjb25zdCB0cmFuc2llbnRFcnJvck5hbWVzID0gW1xuICAgICdNb25nb1dhaXRRdWV1ZVRpbWVvdXRFcnJvcicsXG4gICAgJ01vbmdvU2VydmVyU2VsZWN0aW9uRXJyb3InLFxuICAgICdNb25nb05ldHdvcmtUaW1lb3V0RXJyb3InLFxuICAgICdNb25nb05ldHdvcmtFcnJvcicsXG4gIF07XG4gIGlmICh0cmFuc2llbnRFcnJvck5hbWVzLmluY2x1ZGVzKGVycm9yLm5hbWUpKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAvLyBDaGVjayBmb3IgTW9uZ29EQidzIHRyYW5zaWVudCB0cmFuc2FjdGlvbiBlcnJvciBsYWJlbFxuICBpZiAodHlwZW9mIGVycm9yLmhhc0Vycm9yTGFiZWwgPT09ICdmdW5jdGlvbicpIHtcbiAgICBpZiAoZXJyb3IuaGFzRXJyb3JMYWJlbCgnVHJhbnNpZW50VHJhbnNhY3Rpb25FcnJvcicpKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gZmFsc2U7XG59XG5cbmNvbnN0IHN0b3JhZ2VBZGFwdGVyQWxsQ29sbGVjdGlvbnMgPSBtb25nb0FkYXB0ZXIgPT4ge1xuICByZXR1cm4gbW9uZ29BZGFwdGVyXG4gICAgLmNvbm5lY3QoKVxuICAgIC50aGVuKCgpID0+IG1vbmdvQWRhcHRlci5kYXRhYmFzZS5jb2xsZWN0aW9ucygpKVxuICAgIC50aGVuKGNvbGxlY3Rpb25zID0+IHtcbiAgICAgIHJldHVybiBjb2xsZWN0aW9ucy5maWx0ZXIoY29sbGVjdGlvbiA9PiB7XG4gICAgICAgIGlmIChjb2xsZWN0aW9uLm5hbWVzcGFjZS5tYXRjaCgvXFwuc3lzdGVtXFwuLykpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgLy8gVE9ETzogSWYgeW91IGhhdmUgb25lIGFwcCB3aXRoIGEgY29sbGVjdGlvbiBwcmVmaXggdGhhdCBoYXBwZW5zIHRvIGJlIGEgcHJlZml4IG9mIGFub3RoZXJcbiAgICAgICAgLy8gYXBwcyBwcmVmaXgsIHRoaXMgd2lsbCBnbyB2ZXJ5IHZlcnkgYmFkbHkuIFdlIHNob3VsZCBmaXggdGhhdCBzb21laG93LlxuICAgICAgICByZXR1cm4gY29sbGVjdGlvbi5jb2xsZWN0aW9uTmFtZS5pbmRleE9mKG1vbmdvQWRhcHRlci5fY29sbGVjdGlvblByZWZpeCkgPT0gMDtcbiAgICAgIH0pO1xuICAgIH0pO1xufTtcblxuY29uc3QgY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYSA9ICh7IC4uLnNjaGVtYSB9KSA9PiB7XG4gIGRlbGV0ZSBzY2hlbWEuZmllbGRzLl9ycGVybTtcbiAgZGVsZXRlIHNjaGVtYS5maWVsZHMuX3dwZXJtO1xuXG4gIGlmIChzY2hlbWEuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgLy8gTGVnYWN5IG1vbmdvIGFkYXB0ZXIga25vd3MgYWJvdXQgdGhlIGRpZmZlcmVuY2UgYmV0d2VlbiBwYXNzd29yZCBhbmQgX2hhc2hlZF9wYXNzd29yZC5cbiAgICAvLyBGdXR1cmUgZGF0YWJhc2UgYWRhcHRlcnMgd2lsbCBvbmx5IGtub3cgYWJvdXQgX2hhc2hlZF9wYXNzd29yZC5cbiAgICAvLyBOb3RlOiBQYXJzZSBTZXJ2ZXIgd2lsbCBicmluZyBiYWNrIHBhc3N3b3JkIHdpdGggaW5qZWN0RGVmYXVsdFNjaGVtYSwgc28gd2UgZG9uJ3QgbmVlZFxuICAgIC8vIHRvIGFkZCBfaGFzaGVkX3Bhc3N3b3JkIGJhY2sgZXZlci5cbiAgICBkZWxldGUgc2NoZW1hLmZpZWxkcy5faGFzaGVkX3Bhc3N3b3JkO1xuICB9XG5cbiAgcmV0dXJuIHNjaGVtYTtcbn07XG5cbi8vIFJldHVybnMgeyBjb2RlLCBlcnJvciB9IGlmIGludmFsaWQsIG9yIHsgcmVzdWx0IH0sIGFuIG9iamVjdFxuLy8gc3VpdGFibGUgZm9yIGluc2VydGluZyBpbnRvIF9TQ0hFTUEgY29sbGVjdGlvbiwgb3RoZXJ3aXNlLlxuY29uc3QgbW9uZ29TY2hlbWFGcm9tRmllbGRzQW5kQ2xhc3NOYW1lQW5kQ0xQID0gKFxuICBmaWVsZHMsXG4gIGNsYXNzTmFtZSxcbiAgY2xhc3NMZXZlbFBlcm1pc3Npb25zLFxuICBpbmRleGVzXG4pID0+IHtcbiAgY29uc3QgbW9uZ29PYmplY3QgPSB7XG4gICAgX2lkOiBjbGFzc05hbWUsXG4gICAgb2JqZWN0SWQ6ICdzdHJpbmcnLFxuICAgIHVwZGF0ZWRBdDogJ3N0cmluZycsXG4gICAgY3JlYXRlZEF0OiAnc3RyaW5nJyxcbiAgICBfbWV0YWRhdGE6IHVuZGVmaW5lZCxcbiAgfTtcblxuICBmb3IgKGNvbnN0IGZpZWxkTmFtZSBpbiBmaWVsZHMpIHtcbiAgICBjb25zdCB7IHR5cGUsIHRhcmdldENsYXNzLCAuLi5maWVsZE9wdGlvbnMgfSA9IGZpZWxkc1tmaWVsZE5hbWVdO1xuICAgIG1vbmdvT2JqZWN0W2ZpZWxkTmFtZV0gPSBNb25nb1NjaGVtYUNvbGxlY3Rpb24ucGFyc2VGaWVsZFR5cGVUb01vbmdvRmllbGRUeXBlKHtcbiAgICAgIHR5cGUsXG4gICAgICB0YXJnZXRDbGFzcyxcbiAgICB9KTtcbiAgICBpZiAoZmllbGRPcHRpb25zICYmIE9iamVjdC5rZXlzKGZpZWxkT3B0aW9ucykubGVuZ3RoID4gMCkge1xuICAgICAgbW9uZ29PYmplY3QuX21ldGFkYXRhID0gbW9uZ29PYmplY3QuX21ldGFkYXRhIHx8IHt9O1xuICAgICAgbW9uZ29PYmplY3QuX21ldGFkYXRhLmZpZWxkc19vcHRpb25zID0gbW9uZ29PYmplY3QuX21ldGFkYXRhLmZpZWxkc19vcHRpb25zIHx8IHt9O1xuICAgICAgbW9uZ29PYmplY3QuX21ldGFkYXRhLmZpZWxkc19vcHRpb25zW2ZpZWxkTmFtZV0gPSBmaWVsZE9wdGlvbnM7XG4gICAgfVxuICB9XG5cbiAgaWYgKHR5cGVvZiBjbGFzc0xldmVsUGVybWlzc2lvbnMgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgbW9uZ29PYmplY3QuX21ldGFkYXRhID0gbW9uZ29PYmplY3QuX21ldGFkYXRhIHx8IHt9O1xuICAgIGlmICghY2xhc3NMZXZlbFBlcm1pc3Npb25zKSB7XG4gICAgICBkZWxldGUgbW9uZ29PYmplY3QuX21ldGFkYXRhLmNsYXNzX3Blcm1pc3Npb25zO1xuICAgIH0gZWxzZSB7XG4gICAgICBtb25nb09iamVjdC5fbWV0YWRhdGEuY2xhc3NfcGVybWlzc2lvbnMgPSBjbGFzc0xldmVsUGVybWlzc2lvbnM7XG4gICAgfVxuICB9XG5cbiAgaWYgKGluZGV4ZXMgJiYgdHlwZW9mIGluZGV4ZXMgPT09ICdvYmplY3QnICYmIE9iamVjdC5rZXlzKGluZGV4ZXMpLmxlbmd0aCA+IDApIHtcbiAgICBtb25nb09iamVjdC5fbWV0YWRhdGEgPSBtb25nb09iamVjdC5fbWV0YWRhdGEgfHwge307XG4gICAgbW9uZ29PYmplY3QuX21ldGFkYXRhLmluZGV4ZXMgPSBpbmRleGVzO1xuICB9XG5cbiAgaWYgKCFtb25nb09iamVjdC5fbWV0YWRhdGEpIHtcbiAgICAvLyBjbGVhbnVwIHRoZSB1bnVzZWQgX21ldGFkYXRhXG4gICAgZGVsZXRlIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YTtcbiAgfVxuXG4gIHJldHVybiBtb25nb09iamVjdDtcbn07XG5cbmZ1bmN0aW9uIHZhbGlkYXRlRXhwbGFpblZhbHVlKGV4cGxhaW4pIHtcbiAgaWYgKGV4cGxhaW4pIHtcbiAgICAvLyBUaGUgbGlzdCBvZiBhbGxvd2VkIGV4cGxhaW4gdmFsdWVzIGlzIGZyb20gbm9kZS1tb25nb2RiLW5hdGl2ZS9saWIvZXhwbGFpbi5qc1xuICAgIGNvbnN0IGV4cGxhaW5BbGxvd2VkVmFsdWVzID0gW1xuICAgICAgJ3F1ZXJ5UGxhbm5lcicsXG4gICAgICAncXVlcnlQbGFubmVyRXh0ZW5kZWQnLFxuICAgICAgJ2V4ZWN1dGlvblN0YXRzJyxcbiAgICAgICdhbGxQbGFuc0V4ZWN1dGlvbicsXG4gICAgICBmYWxzZSxcbiAgICAgIHRydWUsXG4gICAgXTtcbiAgICBpZiAoIWV4cGxhaW5BbGxvd2VkVmFsdWVzLmluY2x1ZGVzKGV4cGxhaW4pKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJ0ludmFsaWQgdmFsdWUgZm9yIGV4cGxhaW4nKTtcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIE1vbmdvU3RvcmFnZUFkYXB0ZXIgaW1wbGVtZW50cyBTdG9yYWdlQWRhcHRlciB7XG4gIC8vIFByaXZhdGVcbiAgX3VyaTogc3RyaW5nO1xuICBfY29sbGVjdGlvblByZWZpeDogc3RyaW5nO1xuICBfbW9uZ29PcHRpb25zOiBPYmplY3Q7XG4gIF9vbmNoYW5nZTogYW55O1xuICBfc3RyZWFtOiBhbnk7XG4gIF9sb2dDbGllbnRFdmVudHM6ID9BcnJheTxhbnk+O1xuICBfY2xpZW50TWV0YWRhdGE6ID97IG5hbWU6IHN0cmluZywgdmVyc2lvbjogc3RyaW5nIH07XG4gIC8vIFB1YmxpY1xuICBjb25uZWN0aW9uUHJvbWlzZTogP1Byb21pc2U8YW55PjtcbiAgZGF0YWJhc2U6IGFueTtcbiAgY2xpZW50OiBNb25nb0NsaWVudDtcbiAgX21heFRpbWVNUzogP251bWJlcjtcbiAgX2JhdGNoU2l6ZTogP251bWJlcjtcbiAgY2FuU29ydE9uSm9pblRhYmxlczogYm9vbGVhbjtcbiAgZW5hYmxlU2NoZW1hSG9va3M6IGJvb2xlYW47XG4gIHNjaGVtYUNhY2hlVHRsOiA/bnVtYmVyO1xuICBkaXNhYmxlSW5kZXhGaWVsZFZhbGlkYXRpb246IGJvb2xlYW47XG5cbiAgY29uc3RydWN0b3IoeyB1cmkgPSBkZWZhdWx0cy5EZWZhdWx0TW9uZ29VUkksIGNvbGxlY3Rpb25QcmVmaXggPSAnJywgbW9uZ29PcHRpb25zID0ge30gfTogYW55KSB7XG4gICAgdGhpcy5fdXJpID0gdXJpO1xuICAgIHRoaXMuX2NvbGxlY3Rpb25QcmVmaXggPSBjb2xsZWN0aW9uUHJlZml4O1xuICAgIHRoaXMuX29uY2hhbmdlID0gKCkgPT4ge307XG5cbiAgICAvLyBNYXhUaW1lTVMgaXMgbm90IGEgZ2xvYmFsIE1vbmdvREIgY2xpZW50IG9wdGlvbiwgaXQgaXMgYXBwbGllZCBwZXIgb3BlcmF0aW9uLlxuICAgIHRoaXMuX21heFRpbWVNUyA9IG1vbmdvT3B0aW9ucy5tYXhUaW1lTVM7XG4gICAgLy8gQmF0Y2hTaXplIGlzIG5vdCBhIGdsb2JhbCBNb25nb0RCIGNsaWVudCBvcHRpb24sIGl0IGlzIGFwcGxpZWQgcGVyIGN1cnNvciBvcGVyYXRpb24uXG4gICAgdGhpcy5fYmF0Y2hTaXplID0gbW9uZ29PcHRpb25zLmJhdGNoU2l6ZTtcbiAgICB0aGlzLmNhblNvcnRPbkpvaW5UYWJsZXMgPSB0cnVlO1xuICAgIHRoaXMuZW5hYmxlU2NoZW1hSG9va3MgPSAhIW1vbmdvT3B0aW9ucy5lbmFibGVTY2hlbWFIb29rcztcbiAgICB0aGlzLnNjaGVtYUNhY2hlVHRsID0gbW9uZ29PcHRpb25zLnNjaGVtYUNhY2hlVHRsO1xuICAgIHRoaXMuZGlzYWJsZUluZGV4RmllbGRWYWxpZGF0aW9uID0gISFtb25nb09wdGlvbnMuZGlzYWJsZUluZGV4RmllbGRWYWxpZGF0aW9uO1xuICAgIHRoaXMuX2xvZ0NsaWVudEV2ZW50cyA9IG1vbmdvT3B0aW9ucy5sb2dDbGllbnRFdmVudHM7XG4gICAgdGhpcy5fY2xpZW50TWV0YWRhdGEgPSBtb25nb09wdGlvbnMuY2xpZW50TWV0YWRhdGE7XG5cbiAgICAvLyBDcmVhdGUgYSBjb3B5IG9mIG1vbmdvT3B0aW9ucyBhbmQgcmVtb3ZlIFBhcnNlIFNlcnZlci1zcGVjaWZpYyBvcHRpb25zIHRoYXQgc2hvdWxkIG5vdFxuICAgIC8vIGJlIHBhc3NlZCB0byBNb25nb0RCIGNsaWVudC4gTm90ZTogV2Ugb25seSBkZWxldGUgZnJvbSB0aGlzLl9tb25nb09wdGlvbnMsIG5vdCBmcm9tIHRoZVxuICAgIC8vIG9yaWdpbmFsIG1vbmdvT3B0aW9ucyBvYmplY3QsIGJlY2F1c2Ugb3RoZXIgY29tcG9uZW50cyAobGlrZSBEYXRhYmFzZUNvbnRyb2xsZXIpIG5lZWRcbiAgICAvLyBhY2Nlc3MgdG8gdGhlc2Ugb3B0aW9ucy5cbiAgICB0aGlzLl9tb25nb09wdGlvbnMgPSB7IC4uLm1vbmdvT3B0aW9ucyB9O1xuICAgIGZvciAoY29uc3Qga2V5IG9mIFBhcnNlU2VydmVyRGF0YWJhc2VPcHRpb25zKSB7XG4gICAgICBkZWxldGUgdGhpcy5fbW9uZ29PcHRpb25zW2tleV07XG4gICAgfVxuICB9XG5cbiAgd2F0Y2goY2FsbGJhY2s6ICgpID0+IHZvaWQpOiB2b2lkIHtcbiAgICB0aGlzLl9vbmNoYW5nZSA9IGNhbGxiYWNrO1xuICB9XG5cbiAgY29ubmVjdCgpIHtcbiAgICBpZiAodGhpcy5jb25uZWN0aW9uUHJvbWlzZSkge1xuICAgICAgcmV0dXJuIHRoaXMuY29ubmVjdGlvblByb21pc2U7XG4gICAgfVxuXG4gICAgLy8gcGFyc2luZyBhbmQgcmUtZm9ybWF0dGluZyBjYXVzZXMgdGhlIGF1dGggdmFsdWUgKGlmIHRoZXJlKSB0byBnZXQgVVJJXG4gICAgLy8gZW5jb2RlZFxuICAgIGNvbnN0IGVuY29kZWRVcmkgPSBmb3JtYXRVcmwocGFyc2VVcmwodGhpcy5fdXJpKSk7XG5cbiAgICAvLyBPbmx5IHVzZSBkcml2ZXJJbmZvIGlmIGNsaWVudE1ldGFkYXRhIG9wdGlvbiBpcyBzZXRcbiAgICBjb25zdCBvcHRpb25zID0geyAuLi50aGlzLl9tb25nb09wdGlvbnMgfTtcbiAgICBpZiAodGhpcy5fY2xpZW50TWV0YWRhdGEpIHtcbiAgICAgIG9wdGlvbnMuZHJpdmVySW5mbyA9IHtcbiAgICAgICAgbmFtZTogdGhpcy5fY2xpZW50TWV0YWRhdGEubmFtZSxcbiAgICAgICAgdmVyc2lvbjogdGhpcy5fY2xpZW50TWV0YWRhdGEudmVyc2lvblxuICAgICAgfTtcbiAgICB9XG5cbiAgICB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlID0gTW9uZ29DbGllbnQuY29ubmVjdChlbmNvZGVkVXJpLCBvcHRpb25zKVxuICAgICAgLnRoZW4oY2xpZW50ID0+IHtcbiAgICAgICAgLy8gU3RhcnRpbmcgbW9uZ29EQiAzLjAsIHRoZSBNb25nb0NsaWVudC5jb25uZWN0IGRvbid0IHJldHVybiBhIERCIGFueW1vcmUgYnV0IGEgY2xpZW50XG4gICAgICAgIC8vIEZvcnR1bmF0ZWx5LCB3ZSBjYW4gZ2V0IGJhY2sgdGhlIG9wdGlvbnMgYW5kIHVzZSB0aGVtIHRvIHNlbGVjdCB0aGUgcHJvcGVyIERCLlxuICAgICAgICAvLyBodHRwczovL2dpdGh1Yi5jb20vbW9uZ29kYi9ub2RlLW1vbmdvZGItbmF0aXZlL2Jsb2IvMmMzNWQ3NmYwODU3NDIyNWI4ZGIwMmQ3YmVmNjg3MTIzZTZiYjAxOC9saWIvbW9uZ29fY2xpZW50LmpzI0w4ODVcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNsaWVudC5zLm9wdGlvbnM7XG4gICAgICAgIGNvbnN0IGRhdGFiYXNlID0gY2xpZW50LmRiKG9wdGlvbnMuZGJOYW1lKTtcbiAgICAgICAgaWYgKCFkYXRhYmFzZSkge1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjbGllbnQub24oJ2Vycm9yJywgKCkgPT4ge1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgICAgICB9KTtcbiAgICAgICAgY2xpZW50Lm9uKCdjbG9zZScsICgpID0+IHtcbiAgICAgICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gU2V0IHVwIGNsaWVudCBldmVudCBsb2dnaW5nIGlmIGNvbmZpZ3VyZWRcbiAgICAgICAgaWYgKHRoaXMuX2xvZ0NsaWVudEV2ZW50cyAmJiBBcnJheS5pc0FycmF5KHRoaXMuX2xvZ0NsaWVudEV2ZW50cykpIHtcbiAgICAgICAgICB0aGlzLl9sb2dDbGllbnRFdmVudHMuZm9yRWFjaChldmVudENvbmZpZyA9PiB7XG4gICAgICAgICAgICBjbGllbnQub24oZXZlbnRDb25maWcubmFtZSwgZXZlbnQgPT4ge1xuICAgICAgICAgICAgICBsZXQgbG9nRGF0YSA9IHt9O1xuICAgICAgICAgICAgICBpZiAoIWV2ZW50Q29uZmlnLmtleXMgfHwgZXZlbnRDb25maWcua2V5cy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICBsb2dEYXRhID0gZXZlbnQ7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZXZlbnRDb25maWcua2V5cy5mb3JFYWNoKGtleVBhdGggPT4ge1xuICAgICAgICAgICAgICAgICAgbG9nRGF0YVtrZXlQYXRoXSA9IF8uZ2V0KGV2ZW50LCBrZXlQYXRoKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIC8vIFZhbGlkYXRlIGxvZyBsZXZlbCBleGlzdHMsIGZhbGxiYWNrIHRvICdpbmZvJ1xuICAgICAgICAgICAgICBjb25zdCBsb2dMZXZlbCA9IHR5cGVvZiBsb2dnZXJbZXZlbnRDb25maWcubG9nTGV2ZWxdID09PSAnZnVuY3Rpb24nID8gZXZlbnRDb25maWcubG9nTGV2ZWwgOiAnaW5mbyc7XG5cbiAgICAgICAgICAgICAgLy8gU2FmZSBKU09OIHNlcmlhbGl6YXRpb24gd2l0aCBNYXAvU2V0IGFuZCBjaXJjdWxhciByZWZlcmVuY2Ugc3VwcG9ydFxuICAgICAgICAgICAgICBjb25zdCBsb2dNZXNzYWdlID0gYE1vbmdvREIgY2xpZW50IGV2ZW50ICR7ZXZlbnRDb25maWcubmFtZX06ICR7SlNPTi5zdHJpbmdpZnkobG9nRGF0YSwgVXRpbHMuZ2V0Q2lyY3VsYXJSZXBsYWNlcigpKX1gO1xuXG4gICAgICAgICAgICAgIGxvZ2dlcltsb2dMZXZlbF0obG9nTWVzc2FnZSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuY2xpZW50ID0gY2xpZW50O1xuICAgICAgICB0aGlzLmRhdGFiYXNlID0gZGF0YWJhc2U7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoZXJyKTtcbiAgICAgIH0pO1xuXG4gICAgcmV0dXJuIHRoaXMuY29ubmVjdGlvblByb21pc2U7XG4gIH1cblxuICBoYW5kbGVFcnJvcjxUPihlcnJvcjogPyhFcnJvciB8IFBhcnNlLkVycm9yKSk6IFByb21pc2U8VD4ge1xuICAgIGlmIChlcnJvciAmJiBlcnJvci5jb2RlID09PSAxMykge1xuICAgICAgLy8gVW5hdXRob3JpemVkIGVycm9yXG4gICAgICBkZWxldGUgdGhpcy5jbGllbnQ7XG4gICAgICBkZWxldGUgdGhpcy5kYXRhYmFzZTtcbiAgICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgICAgbG9nZ2VyLmVycm9yKCdSZWNlaXZlZCB1bmF1dGhvcml6ZWQgZXJyb3InLCB7IGVycm9yOiBlcnJvciB9KTtcbiAgICB9XG5cbiAgICAvLyBUcmFuc2Zvcm0gaW5mcmFzdHJ1Y3R1cmUvdHJhbnNpZW50IGVycm9ycyBpbnRvIFBhcnNlLkVycm9yLklOVEVSTkFMX1NFUlZFUl9FUlJPUlxuICAgIGlmIChpc1RyYW5zaWVudEVycm9yKGVycm9yKSkge1xuICAgICAgbG9nZ2VyLmVycm9yKCdEYXRhYmFzZSB0cmFuc2llbnQgZXJyb3InLCBlcnJvcik7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLCAnRGF0YWJhc2UgZXJyb3InKTtcbiAgICB9XG5cbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuXG4gIGFzeW5jIGhhbmRsZVNodXRkb3duKCkge1xuICAgIGlmICghdGhpcy5jbGllbnQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgYXdhaXQgdGhpcy5jbGllbnQuY2xvc2UoZmFsc2UpO1xuICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICB9XG5cbiAgX2FkYXB0aXZlQ29sbGVjdGlvbihuYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5jb25uZWN0KClcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuZGF0YWJhc2UuY29sbGVjdGlvbih0aGlzLl9jb2xsZWN0aW9uUHJlZml4ICsgbmFtZSkpXG4gICAgICAudGhlbihyYXdDb2xsZWN0aW9uID0+IG5ldyBNb25nb0NvbGxlY3Rpb24ocmF3Q29sbGVjdGlvbikpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBfc2NoZW1hQ29sbGVjdGlvbigpOiBQcm9taXNlPE1vbmdvU2NoZW1hQ29sbGVjdGlvbj4ge1xuICAgIHJldHVybiB0aGlzLmNvbm5lY3QoKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKE1vbmdvU2NoZW1hQ29sbGVjdGlvbk5hbWUpKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiB7XG4gICAgICAgIGlmICghdGhpcy5fc3RyZWFtICYmIHRoaXMuZW5hYmxlU2NoZW1hSG9va3MpIHtcbiAgICAgICAgICB0aGlzLl9zdHJlYW0gPSBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24ud2F0Y2goKTtcbiAgICAgICAgICB0aGlzLl9zdHJlYW0ub24oJ2NoYW5nZScsICgpID0+IHRoaXMuX29uY2hhbmdlKCkpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBuZXcgTW9uZ29TY2hlbWFDb2xsZWN0aW9uKGNvbGxlY3Rpb24pO1xuICAgICAgfSk7XG4gIH1cblxuICBjbGFzc0V4aXN0cyhuYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5jb25uZWN0KClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGF0YWJhc2UubGlzdENvbGxlY3Rpb25zKHsgbmFtZTogdGhpcy5fY29sbGVjdGlvblByZWZpeCArIG5hbWUgfSkudG9BcnJheSgpO1xuICAgICAgfSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb25zID0+IHtcbiAgICAgICAgcmV0dXJuIGNvbGxlY3Rpb25zLmxlbmd0aCA+IDA7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgc2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zKGNsYXNzTmFtZTogc3RyaW5nLCBDTFBzOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpXG4gICAgICAudGhlbihzY2hlbWFDb2xsZWN0aW9uID0+XG4gICAgICAgIHNjaGVtYUNvbGxlY3Rpb24udXBkYXRlU2NoZW1hKGNsYXNzTmFtZSwge1xuICAgICAgICAgICRzZXQ6IHsgJ19tZXRhZGF0YS5jbGFzc19wZXJtaXNzaW9ucyc6IENMUHMgfSxcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIHNldEluZGV4ZXNXaXRoU2NoZW1hRm9ybWF0KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHN1Ym1pdHRlZEluZGV4ZXM6IGFueSxcbiAgICBleGlzdGluZ0luZGV4ZXM6IGFueSA9IHt9LFxuICAgIGZpZWxkczogYW55XG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChzdWJtaXR0ZWRJbmRleGVzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICB9XG4gICAgaWYgKE9iamVjdC5rZXlzKGV4aXN0aW5nSW5kZXhlcykubGVuZ3RoID09PSAwKSB7XG4gICAgICBleGlzdGluZ0luZGV4ZXMgPSB7IF9pZF86IHsgX2lkOiAxIH0gfTtcbiAgICB9XG4gICAgY29uc3QgZGVsZXRlUHJvbWlzZXMgPSBbXTtcbiAgICBjb25zdCBpbnNlcnRlZEluZGV4ZXMgPSBbXTtcbiAgICBPYmplY3Qua2V5cyhzdWJtaXR0ZWRJbmRleGVzKS5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgY29uc3QgZmllbGQgPSBzdWJtaXR0ZWRJbmRleGVzW25hbWVdO1xuICAgICAgaWYgKGV4aXN0aW5nSW5kZXhlc1tuYW1lXSAmJiBmaWVsZC5fX29wICE9PSAnRGVsZXRlJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgYEluZGV4ICR7bmFtZX0gZXhpc3RzLCBjYW5ub3QgdXBkYXRlLmApO1xuICAgICAgfVxuICAgICAgaWYgKCFleGlzdGluZ0luZGV4ZXNbbmFtZV0gJiYgZmllbGQuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICAgYEluZGV4ICR7bmFtZX0gZG9lcyBub3QgZXhpc3QsIGNhbm5vdCBkZWxldGUuYFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKGZpZWxkLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLmRyb3BJbmRleChjbGFzc05hbWUsIG5hbWUpO1xuICAgICAgICBkZWxldGVQcm9taXNlcy5wdXNoKHByb21pc2UpO1xuICAgICAgICBkZWxldGUgZXhpc3RpbmdJbmRleGVzW25hbWVdO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgT2JqZWN0LmtleXMoZmllbGQpLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAhdGhpcy5kaXNhYmxlSW5kZXhGaWVsZFZhbGlkYXRpb24gJiZcbiAgICAgICAgICAgICFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoXG4gICAgICAgICAgICAgIGZpZWxkcyxcbiAgICAgICAgICAgICAga2V5LmluZGV4T2YoJ19wXycpID09PSAwID8ga2V5LnJlcGxhY2UoJ19wXycsICcnKSA6IGtleVxuICAgICAgICAgICAgKVxuICAgICAgICAgICkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgICAgICBgRmllbGQgJHtrZXl9IGRvZXMgbm90IGV4aXN0LCBjYW5ub3QgYWRkIGluZGV4LmBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgZXhpc3RpbmdJbmRleGVzW25hbWVdID0gZmllbGQ7XG4gICAgICAgIGluc2VydGVkSW5kZXhlcy5wdXNoKHtcbiAgICAgICAgICBrZXk6IGZpZWxkLFxuICAgICAgICAgIG5hbWUsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGxldCBpbnNlcnRQcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgaWYgKGluc2VydGVkSW5kZXhlcy5sZW5ndGggPiAwKSB7XG4gICAgICBpbnNlcnRQcm9taXNlID0gdGhpcy5jcmVhdGVJbmRleGVzKGNsYXNzTmFtZSwgaW5zZXJ0ZWRJbmRleGVzKTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UuYWxsKGRlbGV0ZVByb21pc2VzKVxuICAgICAgLnRoZW4oKCkgPT4gaW5zZXJ0UHJvbWlzZSlcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKSlcbiAgICAgIC50aGVuKHNjaGVtYUNvbGxlY3Rpb24gPT5cbiAgICAgICAgc2NoZW1hQ29sbGVjdGlvbi51cGRhdGVTY2hlbWEoY2xhc3NOYW1lLCB7XG4gICAgICAgICAgJHNldDogeyAnX21ldGFkYXRhLmluZGV4ZXMnOiBleGlzdGluZ0luZGV4ZXMgfSxcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIHNldEluZGV4ZXNGcm9tTW9uZ28oY2xhc3NOYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5nZXRJbmRleGVzKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGluZGV4ZXMgPT4ge1xuICAgICAgICBpbmRleGVzID0gaW5kZXhlcy5yZWR1Y2UoKG9iaiwgaW5kZXgpID0+IHtcbiAgICAgICAgICBpZiAoaW5kZXgua2V5Ll9mdHMpIHtcbiAgICAgICAgICAgIGRlbGV0ZSBpbmRleC5rZXkuX2Z0cztcbiAgICAgICAgICAgIGRlbGV0ZSBpbmRleC5rZXkuX2Z0c3g7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIGluZGV4LndlaWdodHMpIHtcbiAgICAgICAgICAgICAgaW5kZXgua2V5W2ZpZWxkXSA9ICd0ZXh0JztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgb2JqW2luZGV4Lm5hbWVdID0gaW5kZXgua2V5O1xuICAgICAgICAgIHJldHVybiBvYmo7XG4gICAgICAgIH0sIHt9KTtcbiAgICAgICAgcmV0dXJuIHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKS50aGVuKHNjaGVtYUNvbGxlY3Rpb24gPT5cbiAgICAgICAgICBzY2hlbWFDb2xsZWN0aW9uLnVwZGF0ZVNjaGVtYShjbGFzc05hbWUsIHtcbiAgICAgICAgICAgICRzZXQ6IHsgJ19tZXRhZGF0YS5pbmRleGVzJzogaW5kZXhlcyB9LFxuICAgICAgICAgIH0pXG4gICAgICAgICk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpXG4gICAgICAuY2F0Y2goKCkgPT4ge1xuICAgICAgICAvLyBJZ25vcmUgaWYgY29sbGVjdGlvbiBub3QgZm91bmRcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgfSk7XG4gIH1cblxuICBjcmVhdGVDbGFzcyhjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvT2JqZWN0ID0gbW9uZ29TY2hlbWFGcm9tRmllbGRzQW5kQ2xhc3NOYW1lQW5kQ0xQKFxuICAgICAgc2NoZW1hLmZpZWxkcyxcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHNjaGVtYS5jbGFzc0xldmVsUGVybWlzc2lvbnMsXG4gICAgICBzY2hlbWEuaW5kZXhlc1xuICAgICk7XG4gICAgbW9uZ29PYmplY3QuX2lkID0gY2xhc3NOYW1lO1xuICAgIHJldHVybiB0aGlzLnNldEluZGV4ZXNXaXRoU2NoZW1hRm9ybWF0KGNsYXNzTmFtZSwgc2NoZW1hLmluZGV4ZXMsIHt9LCBzY2hlbWEuZmllbGRzKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpKVxuICAgICAgLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PiBzY2hlbWFDb2xsZWN0aW9uLmluc2VydFNjaGVtYShtb25nb09iamVjdCkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBhc3luYyB1cGRhdGVGaWVsZE9wdGlvbnMoY2xhc3NOYW1lOiBzdHJpbmcsIGZpZWxkTmFtZTogc3RyaW5nLCB0eXBlOiBhbnkpIHtcbiAgICBjb25zdCBzY2hlbWFDb2xsZWN0aW9uID0gYXdhaXQgdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpO1xuICAgIGF3YWl0IHNjaGVtYUNvbGxlY3Rpb24udXBkYXRlRmllbGRPcHRpb25zKGNsYXNzTmFtZSwgZmllbGROYW1lLCB0eXBlKTtcbiAgfVxuXG4gIGFkZEZpZWxkSWZOb3RFeGlzdHMoY2xhc3NOYW1lOiBzdHJpbmcsIGZpZWxkTmFtZTogc3RyaW5nLCB0eXBlOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpXG4gICAgICAudGhlbihzY2hlbWFDb2xsZWN0aW9uID0+IHNjaGVtYUNvbGxlY3Rpb24uYWRkRmllbGRJZk5vdEV4aXN0cyhjbGFzc05hbWUsIGZpZWxkTmFtZSwgdHlwZSkpXG4gICAgICAudGhlbigoKSA9PiB0aGlzLmNyZWF0ZUluZGV4ZXNJZk5lZWRlZChjbGFzc05hbWUsIGZpZWxkTmFtZSwgdHlwZSkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBEcm9wcyBhIGNvbGxlY3Rpb24uIFJlc29sdmVzIHdpdGggdHJ1ZSBpZiBpdCB3YXMgYSBQYXJzZSBTY2hlbWEgKGVnLiBfVXNlciwgQ3VzdG9tLCBldGMuKVxuICAvLyBhbmQgcmVzb2x2ZXMgd2l0aCBmYWxzZSBpZiBpdCB3YXNuJ3QgKGVnLiBhIGpvaW4gdGFibGUpLiBSZWplY3RzIGlmIGRlbGV0aW9uIHdhcyBpbXBvc3NpYmxlLlxuICBkZWxldGVDbGFzcyhjbGFzc05hbWU6IHN0cmluZykge1xuICAgIHJldHVybiAoXG4gICAgICB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uZHJvcCgpKVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgIC8vICducyBub3QgZm91bmQnIG1lYW5zIGNvbGxlY3Rpb24gd2FzIGFscmVhZHkgZ29uZS4gSWdub3JlIGRlbGV0aW9uIGF0dGVtcHQuXG4gICAgICAgICAgaWYgKGVycm9yLm1lc3NhZ2UgPT0gJ25zIG5vdCBmb3VuZCcpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH0pXG4gICAgICAgIC8vIFdlJ3ZlIGRyb3BwZWQgdGhlIGNvbGxlY3Rpb24sIG5vdyByZW1vdmUgdGhlIF9TQ0hFTUEgZG9jdW1lbnRcbiAgICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpKVxuICAgICAgICAudGhlbihzY2hlbWFDb2xsZWN0aW9uID0+IHNjaGVtYUNvbGxlY3Rpb24uZmluZEFuZERlbGV0ZVNjaGVtYShjbGFzc05hbWUpKVxuICAgICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSlcbiAgICApO1xuICB9XG5cbiAgZGVsZXRlQWxsQ2xhc3NlcyhmYXN0OiBib29sZWFuKSB7XG4gICAgcmV0dXJuIHN0b3JhZ2VBZGFwdGVyQWxsQ29sbGVjdGlvbnModGhpcykudGhlbihjb2xsZWN0aW9ucyA9PlxuICAgICAgUHJvbWlzZS5hbGwoXG4gICAgICAgIGNvbGxlY3Rpb25zLm1hcChjb2xsZWN0aW9uID0+IChmYXN0ID8gY29sbGVjdGlvbi5kZWxldGVNYW55KHt9KSA6IGNvbGxlY3Rpb24uZHJvcCgpKSlcbiAgICAgIClcbiAgICApO1xuICB9XG5cbiAgLy8gUmVtb3ZlIHRoZSBjb2x1bW4gYW5kIGFsbCB0aGUgZGF0YS4gRm9yIFJlbGF0aW9ucywgdGhlIF9Kb2luIGNvbGxlY3Rpb24gaXMgaGFuZGxlZFxuICAvLyBzcGVjaWFsbHksIHRoaXMgZnVuY3Rpb24gZG9lcyBub3QgZGVsZXRlIF9Kb2luIGNvbHVtbnMuIEl0IHNob3VsZCwgaG93ZXZlciwgaW5kaWNhdGVcbiAgLy8gdGhhdCB0aGUgcmVsYXRpb24gZmllbGRzIGRvZXMgbm90IGV4aXN0IGFueW1vcmUuIEluIG1vbmdvLCB0aGlzIG1lYW5zIHJlbW92aW5nIGl0IGZyb21cbiAgLy8gdGhlIF9TQ0hFTUEgY29sbGVjdGlvbi4gIFRoZXJlIHNob3VsZCBiZSBubyBhY3R1YWwgZGF0YSBpbiB0aGUgY29sbGVjdGlvbiB1bmRlciB0aGUgc2FtZSBuYW1lXG4gIC8vIGFzIHRoZSByZWxhdGlvbiBjb2x1bW4sIHNvIGl0J3MgZmluZSB0byBhdHRlbXB0IHRvIGRlbGV0ZSBpdC4gSWYgdGhlIGZpZWxkcyBsaXN0ZWQgdG8gYmVcbiAgLy8gZGVsZXRlZCBkbyBub3QgZXhpc3QsIHRoaXMgZnVuY3Rpb24gc2hvdWxkIHJldHVybiBzdWNjZXNzZnVsbHkgYW55d2F5cy4gQ2hlY2tpbmcgZm9yXG4gIC8vIGF0dGVtcHRzIHRvIGRlbGV0ZSBub24tZXhpc3RlbnQgZmllbGRzIGlzIHRoZSByZXNwb25zaWJpbGl0eSBvZiBQYXJzZSBTZXJ2ZXIuXG5cbiAgLy8gUG9pbnRlciBmaWVsZCBuYW1lcyBhcmUgcGFzc2VkIGZvciBsZWdhY3kgcmVhc29uczogdGhlIG9yaWdpbmFsIG1vbmdvXG4gIC8vIGZvcm1hdCBzdG9yZWQgcG9pbnRlciBmaWVsZCBuYW1lcyBkaWZmZXJlbnRseSBpbiB0aGUgZGF0YWJhc2UsIGFuZCB0aGVyZWZvcmVcbiAgLy8gbmVlZGVkIHRvIGtub3cgdGhlIHR5cGUgb2YgdGhlIGZpZWxkIGJlZm9yZSBpdCBjb3VsZCBkZWxldGUgaXQuIEZ1dHVyZSBkYXRhYmFzZVxuICAvLyBhZGFwdGVycyBzaG91bGQgaWdub3JlIHRoZSBwb2ludGVyRmllbGROYW1lcyBhcmd1bWVudC4gQWxsIHRoZSBmaWVsZCBuYW1lcyBhcmUgaW5cbiAgLy8gZmllbGROYW1lcywgdGhleSBzaG93IHVwIGFkZGl0aW9uYWxseSBpbiB0aGUgcG9pbnRlckZpZWxkTmFtZXMgZGF0YWJhc2UgZm9yIHVzZVxuICAvLyBieSB0aGUgbW9uZ28gYWRhcHRlciwgd2hpY2ggZGVhbHMgd2l0aCB0aGUgbGVnYWN5IG1vbmdvIGZvcm1hdC5cblxuICAvLyBUaGlzIGZ1bmN0aW9uIGlzIG5vdCBvYmxpZ2F0ZWQgdG8gZGVsZXRlIGZpZWxkcyBhdG9taWNhbGx5LiBJdCBpcyBnaXZlbiB0aGUgZmllbGRcbiAgLy8gbmFtZXMgaW4gYSBsaXN0IHNvIHRoYXQgZGF0YWJhc2VzIHRoYXQgYXJlIGNhcGFibGUgb2YgZGVsZXRpbmcgZmllbGRzIGF0b21pY2FsbHlcbiAgLy8gbWF5IGRvIHNvLlxuXG4gIC8vIFJldHVybnMgYSBQcm9taXNlLlxuICBkZWxldGVGaWVsZHMoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgZmllbGROYW1lczogc3RyaW5nW10pIHtcbiAgICBjb25zdCBtb25nb0Zvcm1hdE5hbWVzID0gZmllbGROYW1lcy5tYXAoZmllbGROYW1lID0+IHtcbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1BvaW50ZXInKSB7XG4gICAgICAgIHJldHVybiBgX3BfJHtmaWVsZE5hbWV9YDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiBmaWVsZE5hbWU7XG4gICAgICB9XG4gICAgfSk7XG4gICAgY29uc3QgY29sbGVjdGlvblVwZGF0ZSA9IHsgJHVuc2V0OiB7fSB9O1xuICAgIG1vbmdvRm9ybWF0TmFtZXMuZm9yRWFjaChuYW1lID0+IHtcbiAgICAgIGNvbGxlY3Rpb25VcGRhdGVbJyR1bnNldCddW25hbWVdID0gbnVsbDtcbiAgICB9KTtcblxuICAgIGNvbnN0IGNvbGxlY3Rpb25GaWx0ZXIgPSB7ICRvcjogW10gfTtcbiAgICBtb25nb0Zvcm1hdE5hbWVzLmZvckVhY2gobmFtZSA9PiB7XG4gICAgICBjb2xsZWN0aW9uRmlsdGVyWyckb3InXS5wdXNoKHsgW25hbWVdOiB7ICRleGlzdHM6IHRydWUgfSB9KTtcbiAgICB9KTtcblxuICAgIGNvbnN0IHNjaGVtYVVwZGF0ZSA9IHsgJHVuc2V0OiB7fSB9O1xuICAgIGZpZWxkTmFtZXMuZm9yRWFjaChuYW1lID0+IHtcbiAgICAgIHNjaGVtYVVwZGF0ZVsnJHVuc2V0J11bbmFtZV0gPSBudWxsO1xuICAgICAgc2NoZW1hVXBkYXRlWyckdW5zZXQnXVtgX21ldGFkYXRhLmZpZWxkc19vcHRpb25zLiR7bmFtZX1gXSA9IG51bGw7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi51cGRhdGVNYW55KGNvbGxlY3Rpb25GaWx0ZXIsIGNvbGxlY3Rpb25VcGRhdGUpKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpKVxuICAgICAgLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PiBzY2hlbWFDb2xsZWN0aW9uLnVwZGF0ZVNjaGVtYShjbGFzc05hbWUsIHNjaGVtYVVwZGF0ZSkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBSZXR1cm4gYSBwcm9taXNlIGZvciBhbGwgc2NoZW1hcyBrbm93biB0byB0aGlzIGFkYXB0ZXIsIGluIFBhcnNlIGZvcm1hdC4gSW4gY2FzZSB0aGVcbiAgLy8gc2NoZW1hcyBjYW5ub3QgYmUgcmV0cmlldmVkLCByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlamVjdHMuIFJlcXVpcmVtZW50cyBmb3IgdGhlXG4gIC8vIHJlamVjdGlvbiByZWFzb24gYXJlIFRCRC5cbiAgZ2V0QWxsQ2xhc3NlcygpOiBQcm9taXNlPFN0b3JhZ2VDbGFzc1tdPiB7XG4gICAgcmV0dXJuIHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKVxuICAgICAgLnRoZW4oc2NoZW1hc0NvbGxlY3Rpb24gPT4gc2NoZW1hc0NvbGxlY3Rpb24uX2ZldGNoQWxsU2NoZW1hc0Zyb21fU0NIRU1BKCkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBSZXR1cm4gYSBwcm9taXNlIGZvciB0aGUgc2NoZW1hIHdpdGggdGhlIGdpdmVuIG5hbWUsIGluIFBhcnNlIGZvcm1hdC4gSWZcbiAgLy8gdGhpcyBhZGFwdGVyIGRvZXNuJ3Qga25vdyBhYm91dCB0aGUgc2NoZW1hLCByZXR1cm4gYSBwcm9taXNlIHRoYXQgcmVqZWN0cyB3aXRoXG4gIC8vIHVuZGVmaW5lZCBhcyB0aGUgcmVhc29uLlxuICBnZXRDbGFzcyhjbGFzc05hbWU6IHN0cmluZyk6IFByb21pc2U8U3RvcmFnZUNsYXNzPiB7XG4gICAgcmV0dXJuIHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKVxuICAgICAgLnRoZW4oc2NoZW1hc0NvbGxlY3Rpb24gPT4gc2NoZW1hc0NvbGxlY3Rpb24uX2ZldGNoT25lU2NoZW1hRnJvbV9TQ0hFTUEoY2xhc3NOYW1lKSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIFRPRE86IEFzIHlldCBub3QgcGFydGljdWxhcmx5IHdlbGwgc3BlY2lmaWVkLiBDcmVhdGVzIGFuIG9iamVjdC4gTWF5YmUgc2hvdWxkbid0IGV2ZW4gbmVlZCB0aGUgc2NoZW1hLFxuICAvLyBhbmQgc2hvdWxkIGluZmVyIGZyb20gdGhlIHR5cGUuIE9yIG1heWJlIGRvZXMgbmVlZCB0aGUgc2NoZW1hIGZvciB2YWxpZGF0aW9ucy4gT3IgbWF5YmUgbmVlZHNcbiAgLy8gdGhlIHNjaGVtYSBvbmx5IGZvciB0aGUgbGVnYWN5IG1vbmdvIGZvcm1hdC4gV2UnbGwgZmlndXJlIHRoYXQgb3V0IGxhdGVyLlxuICBjcmVhdGVPYmplY3QoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgb2JqZWN0OiBhbnksIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55KSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvT2JqZWN0ID0gcGFyc2VPYmplY3RUb01vbmdvT2JqZWN0Rm9yQ3JlYXRlKGNsYXNzTmFtZSwgb2JqZWN0LCBzY2hlbWEpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLmluc2VydE9uZShtb25nb09iamVjdCwgdHJhbnNhY3Rpb25hbFNlc3Npb24pKVxuICAgICAgLnRoZW4oKCkgPT4gKHsgb3BzOiBbbW9uZ29PYmplY3RdIH0pKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IDExMDAwKSB7XG4gICAgICAgICAgbG9nZ2VyLmVycm9yKCdEdXBsaWNhdGUga2V5IGVycm9yOicsIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgIGNvbnN0IGVyciA9IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICk7XG4gICAgICAgICAgZXJyLnVuZGVybHlpbmdFcnJvciA9IGVycm9yO1xuICAgICAgICAgIGlmIChlcnJvci5tZXNzYWdlKSB7XG4gICAgICAgICAgICBjb25zdCBtYXRjaGVzID0gZXJyb3IubWVzc2FnZS5tYXRjaCgvaW5kZXg6W1xcc2EtekEtWjAtOV9cXC1cXC5dK1xcJD8oW2EtekEtWl8tXSspXzEvKTtcbiAgICAgICAgICAgIGlmIChtYXRjaGVzICYmIEFycmF5LmlzQXJyYXkobWF0Y2hlcykpIHtcbiAgICAgICAgICAgICAgZXJyLnVzZXJJbmZvID0geyBkdXBsaWNhdGVkX2ZpZWxkOiBtYXRjaGVzWzFdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBDaGVjayBmb3IgYXV0aERhdGEgdW5pcXVlIGluZGV4IHZpb2xhdGlvbnNcbiAgICAgICAgICAgIGlmICghZXJyLnVzZXJJbmZvKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGF1dGhEYXRhTWF0Y2ggPSBlcnJvci5tZXNzYWdlLm1hdGNoKC9pbmRleDpcXHMrKF9hdXRoX2RhdGFfW2EtekEtWjAtOV9dK19pZCkvKTtcbiAgICAgICAgICAgICAgaWYgKGF1dGhEYXRhTWF0Y2gpIHtcbiAgICAgICAgICAgICAgICBlcnIudXNlckluZm8gPSB7IGR1cGxpY2F0ZWRfZmllbGQ6IGF1dGhEYXRhTWF0Y2hbMV0gfTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgY3JlYXRlT2JqZWN0cyhjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBvYmplY3RzOiBhbnksIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55KSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvT2JqZWN0cyA9IG9iamVjdHMubWFwKG9iamVjdCA9PlxuICAgICAgcGFyc2VPYmplY3RUb01vbmdvT2JqZWN0Rm9yQ3JlYXRlKGNsYXNzTmFtZSwgb2JqZWN0LCBzY2hlbWEpXG4gICAgKTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5pbnNlcnRNYW55KG1vbmdvT2JqZWN0cywgdHJhbnNhY3Rpb25hbFNlc3Npb24pKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IDExMDAwKSB7XG4gICAgICAgICAgbG9nZ2VyLmVycm9yKCdEdXBsaWNhdGUga2V5IGVycm9yOicsIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgIGNvbnN0IGVyciA9IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICk7XG4gICAgICAgICAgZXJyLnVuZGVybHlpbmdFcnJvciA9IGVycm9yO1xuICAgICAgICAgIGlmIChlcnJvci5tZXNzYWdlKSB7XG4gICAgICAgICAgICBjb25zdCBtYXRjaGVzID0gZXJyb3IubWVzc2FnZS5tYXRjaChcbiAgICAgICAgICAgICAgL2luZGV4OltcXHNhLXpBLVowLTlfXFwtXFwuXStcXCQ/KFthLXpBLVpfLV0rKV8xL1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmIChtYXRjaGVzICYmIEFycmF5LmlzQXJyYXkobWF0Y2hlcykpIHtcbiAgICAgICAgICAgICAgZXJyLnVzZXJJbmZvID0geyBkdXBsaWNhdGVkX2ZpZWxkOiBtYXRjaGVzWzFdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIWVyci51c2VySW5mbykge1xuICAgICAgICAgICAgICBjb25zdCBhdXRoRGF0YU1hdGNoID0gZXJyb3IubWVzc2FnZS5tYXRjaCgvaW5kZXg6XFxzKyhfYXV0aF9kYXRhX1thLXpBLVowLTlfXStfaWQpLyk7XG4gICAgICAgICAgICAgIGlmIChhdXRoRGF0YU1hdGNoKSB7XG4gICAgICAgICAgICAgICAgZXJyLnVzZXJJbmZvID0geyBkdXBsaWNhdGVkX2ZpZWxkOiBhdXRoRGF0YU1hdGNoWzFdIH07XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIFJlbW92ZSBhbGwgb2JqZWN0cyB0aGF0IG1hdGNoIHRoZSBnaXZlbiBQYXJzZSBRdWVyeS5cbiAgLy8gSWYgbm8gb2JqZWN0cyBtYXRjaCwgcmVqZWN0IHdpdGggT0JKRUNUX05PVF9GT1VORC4gSWYgb2JqZWN0cyBhcmUgZm91bmQgYW5kIGRlbGV0ZWQsIHJlc29sdmUgd2l0aCB1bmRlZmluZWQuXG4gIC8vIElmIHRoZXJlIGlzIHNvbWUgb3RoZXIgZXJyb3IsIHJlamVjdCB3aXRoIElOVEVSTkFMX1NFUlZFUl9FUlJPUi5cbiAgZGVsZXRlT2JqZWN0c0J5UXVlcnkoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgdHJhbnNhY3Rpb25hbFNlc3Npb246ID9hbnlcbiAgKSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiB7XG4gICAgICAgIGNvbnN0IG1vbmdvV2hlcmUgPSB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpO1xuICAgICAgICByZXR1cm4gY29sbGVjdGlvbi5kZWxldGVNYW55KG1vbmdvV2hlcmUsIHRyYW5zYWN0aW9uYWxTZXNzaW9uKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSlcbiAgICAgIC50aGVuKFxuICAgICAgICAoeyBkZWxldGVkQ291bnQgfSkgPT4ge1xuICAgICAgICAgIGlmIChkZWxldGVkQ291bnQgPT09IDApIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnT2JqZWN0IG5vdCBmb3VuZC4nKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9LFxuICAgICAgICAoKSA9PiB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVEVSTkFMX1NFUlZFUl9FUlJPUiwgJ0RhdGFiYXNlIGFkYXB0ZXIgZXJyb3InKTtcbiAgICAgICAgfVxuICAgICAgKTtcbiAgfVxuXG4gIC8vIEFwcGx5IHRoZSB1cGRhdGUgdG8gYWxsIG9iamVjdHMgdGhhdCBtYXRjaCB0aGUgZ2l2ZW4gUGFyc2UgUXVlcnkuXG4gIHVwZGF0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHVwZGF0ZTogYW55LFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1VwZGF0ZSA9IHRyYW5zZm9ybVVwZGF0ZShjbGFzc05hbWUsIHVwZGF0ZSwgc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1doZXJlID0gdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hKTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi51cGRhdGVNYW55KG1vbmdvV2hlcmUsIG1vbmdvVXBkYXRlLCB0cmFuc2FjdGlvbmFsU2Vzc2lvbikpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBBdG9taWNhbGx5IGZpbmRzIGFuZCB1cGRhdGVzIGFuIG9iamVjdCBiYXNlZCBvbiBxdWVyeS5cbiAgLy8gUmV0dXJuIHZhbHVlIG5vdCBjdXJyZW50bHkgd2VsbCBzcGVjaWZpZWQuXG4gIGZpbmRPbmVBbmRVcGRhdGUoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgdXBkYXRlOiBhbnksXG4gICAgdHJhbnNhY3Rpb25hbFNlc3Npb246ID9hbnlcbiAgKSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvVXBkYXRlID0gdHJhbnNmb3JtVXBkYXRlKGNsYXNzTmFtZSwgdXBkYXRlLCBzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvV2hlcmUgPSB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uZmluZE9uZUFuZFVwZGF0ZShtb25nb1doZXJlLCBtb25nb1VwZGF0ZSwge1xuICAgICAgICAgIHJldHVybkRvY3VtZW50OiAnYWZ0ZXInLFxuICAgICAgICAgIHNlc3Npb246IHRyYW5zYWN0aW9uYWxTZXNzaW9uIHx8IHVuZGVmaW5lZCxcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC50aGVuKHJlc3VsdCA9PiBtb25nb09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lLCByZXN1bHQsIHNjaGVtYSkpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gMTEwMDApIHtcbiAgICAgICAgICBsb2dnZXIuZXJyb3IoJ0R1cGxpY2F0ZSBrZXkgZXJyb3I6JywgZXJyb3IubWVzc2FnZSk7XG4gICAgICAgICAgY29uc3QgZXJyID0gbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICAgJ0EgZHVwbGljYXRlIHZhbHVlIGZvciBhIGZpZWxkIHdpdGggdW5pcXVlIHZhbHVlcyB3YXMgcHJvdmlkZWQnXG4gICAgICAgICAgKTtcbiAgICAgICAgICBlcnIudW5kZXJseWluZ0Vycm9yID0gZXJyb3I7XG4gICAgICAgICAgaWYgKGVycm9yLm1lc3NhZ2UpIHtcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoZXMgPSBlcnJvci5tZXNzYWdlLm1hdGNoKC9pbmRleDpbXFxzYS16QS1aMC05X1xcLVxcLl0rXFwkPyhbYS16QS1aXy1dKylfMS8pO1xuICAgICAgICAgICAgaWYgKG1hdGNoZXMgJiYgQXJyYXkuaXNBcnJheShtYXRjaGVzKSkge1xuICAgICAgICAgICAgICBlcnIudXNlckluZm8gPSB7IGR1cGxpY2F0ZWRfZmllbGQ6IG1hdGNoZXNbMV0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghZXJyLnVzZXJJbmZvKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGF1dGhEYXRhTWF0Y2ggPSBlcnJvci5tZXNzYWdlLm1hdGNoKC9pbmRleDpcXHMrKF9hdXRoX2RhdGFfW2EtekEtWjAtOV9dK19pZCkvKTtcbiAgICAgICAgICAgICAgaWYgKGF1dGhEYXRhTWF0Y2gpIHtcbiAgICAgICAgICAgICAgICBlcnIudXNlckluZm8gPSB7IGR1cGxpY2F0ZWRfZmllbGQ6IGF1dGhEYXRhTWF0Y2hbMV0gfTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgdXBkYXRlT2JqZWN0c0J5QnVsayhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgb3BlcmF0aW9uczogYW55LFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBidWxrcyA9IG9wZXJhdGlvbnMubWFwKCh7IHVwZGF0ZU9uZSwgdXBkYXRlTWFueSwgaW5zZXJ0T25lIH0pID0+IHtcbiAgICAgIGlmICh1cGRhdGVPbmUpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICB1cGRhdGVPbmU6IHtcbiAgICAgICAgICAgIGZpbHRlcjogdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCB1cGRhdGVPbmUuZmlsdGVyLCBzY2hlbWEpLFxuICAgICAgICAgICAgdXBkYXRlOiB0cmFuc2Zvcm1VcGRhdGUoY2xhc3NOYW1lLCB1cGRhdGVPbmUudXBkYXRlLCBzY2hlbWEpLFxuICAgICAgICAgICAgdXBzZXJ0OiBmYWxzZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgaWYgKHVwZGF0ZU1hbnkpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICB1cGRhdGVNYW55OiB7XG4gICAgICAgICAgICBmaWx0ZXI6IHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgdXBkYXRlTWFueS5maWx0ZXIsIHNjaGVtYSksXG4gICAgICAgICAgICB1cGRhdGU6IHRyYW5zZm9ybVVwZGF0ZShjbGFzc05hbWUsIHVwZGF0ZU1hbnkudXBkYXRlLCBzY2hlbWEpLFxuICAgICAgICAgICAgdXBzZXJ0OiBmYWxzZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgaW5zZXJ0T25lOiB7XG4gICAgICAgICAgZG9jdW1lbnQ6IHBhcnNlT2JqZWN0VG9Nb25nb09iamVjdEZvckNyZWF0ZShjbGFzc05hbWUsIGluc2VydE9uZS5kb2N1bWVudCwgc2NoZW1hKSxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+XG4gICAgICAgIGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5idWxrV3JpdGUoYnVsa3MsIHtcbiAgICAgICAgICBzZXNzaW9uOiB0cmFuc2FjdGlvbmFsU2Vzc2lvbiB8fCB1bmRlZmluZWQsXG4gICAgICAgICAgb3JkZXJlZDogZmFsc2UsXG4gICAgICAgICAgYnlwYXNzRG9jdW1lbnRWYWxpZGF0aW9uOiB0cnVlLFxuICAgICAgICAgIHdyaXRlQ29uY2VybjogeyB3OiAxLCBqOiBmYWxzZSB9LFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IDExMDAwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICAgJ0EgZHVwbGljYXRlIHZhbHVlIGZvciBhIGZpZWxkIHdpdGggdW5pcXVlIHZhbHVlcyB3YXMgcHJvdmlkZWQnXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBIb3BlZnVsbHkgd2UgY2FuIGdldCByaWQgb2YgdGhpcy4gSXQncyBvbmx5IHVzZWQgZm9yIGNvbmZpZyBhbmQgaG9va3MuXG4gIHVwc2VydE9uZU9iamVjdChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICB1cGRhdGU6IGFueSxcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbjogP2FueVxuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29VcGRhdGUgPSB0cmFuc2Zvcm1VcGRhdGUoY2xhc3NOYW1lLCB1cGRhdGUsIHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29XaGVyZSA9IHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24udXBzZXJ0T25lKG1vbmdvV2hlcmUsIG1vbmdvVXBkYXRlLCB0cmFuc2FjdGlvbmFsU2Vzc2lvbikpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBFeGVjdXRlcyBhIGZpbmQuIEFjY2VwdHM6IGNsYXNzTmFtZSwgcXVlcnkgaW4gUGFyc2UgZm9ybWF0LCBhbmQgeyBza2lwLCBsaW1pdCwgc29ydCB9LlxuICBmaW5kKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHtcbiAgICAgIHNraXAsXG4gICAgICBsaW1pdCxcbiAgICAgIHNvcnQsXG4gICAgICBrZXlzLFxuICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICBoaW50LFxuICAgICAgY2FzZUluc2Vuc2l0aXZlLFxuICAgICAgZXhwbGFpbixcbiAgICAgIGNvbW1lbnQsXG4gICAgfTogUXVlcnlPcHRpb25zXG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgdmFsaWRhdGVFeHBsYWluVmFsdWUoZXhwbGFpbik7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvV2hlcmUgPSB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvU29ydCA9IF8ubWFwS2V5cyhzb3J0LCAodmFsdWUsIGZpZWxkTmFtZSkgPT5cbiAgICAgIHRyYW5zZm9ybUtleShjbGFzc05hbWUsIGZpZWxkTmFtZSwgc2NoZW1hKVxuICAgICk7XG4gICAgY29uc3QgbW9uZ29LZXlzID0gXy5yZWR1Y2UoXG4gICAgICBrZXlzLFxuICAgICAgKG1lbW8sIGtleSkgPT4ge1xuICAgICAgICBpZiAoa2V5ID09PSAnQUNMJykge1xuICAgICAgICAgIG1lbW9bJ19ycGVybSddID0gMTtcbiAgICAgICAgICBtZW1vWydfd3Blcm0nXSA9IDE7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgbWVtb1t0cmFuc2Zvcm1LZXkoY2xhc3NOYW1lLCBrZXksIHNjaGVtYSldID0gMTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbWVtbztcbiAgICAgIH0sXG4gICAgICB7fVxuICAgICk7XG5cbiAgICAvLyBJZiB3ZSBhcmVuJ3QgcmVxdWVzdGluZyB0aGUgYF9pZGAgZmllbGQsIHdlIG5lZWQgdG8gZXhwbGljaXRseSBvcHQgb3V0XG4gICAgLy8gb2YgaXQuIERvaW5nIHNvIGluIHBhcnNlLXNlcnZlciBpcyB1bnVzdWFsLCBidXQgaXQgY2FuIGFsbG93IHVzIHRvXG4gICAgLy8gb3B0aW1pemUgc29tZSBxdWVyaWVzIHdpdGggY292ZXJpbmcgaW5kZXhlcy5cbiAgICBpZiAoa2V5cyAmJiAhbW9uZ29LZXlzLl9pZCkge1xuICAgICAgbW9uZ29LZXlzLl9pZCA9IDA7XG4gICAgfVxuXG4gICAgcmVhZFByZWZlcmVuY2UgPSB0aGlzLl9wYXJzZVJlYWRQcmVmZXJlbmNlKHJlYWRQcmVmZXJlbmNlKTtcbiAgICByZXR1cm4gdGhpcy5jcmVhdGVUZXh0SW5kZXhlc0lmTmVlZGVkKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSlcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLmZpbmQobW9uZ29XaGVyZSwge1xuICAgICAgICAgIHNraXAsXG4gICAgICAgICAgbGltaXQsXG4gICAgICAgICAgc29ydDogbW9uZ29Tb3J0LFxuICAgICAgICAgIGtleXM6IG1vbmdvS2V5cyxcbiAgICAgICAgICBtYXhUaW1lTVM6IHRoaXMuX21heFRpbWVNUyxcbiAgICAgICAgICBiYXRjaFNpemU6IHRoaXMuX2JhdGNoU2l6ZSxcbiAgICAgICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgICAgICBoaW50LFxuICAgICAgICAgIGNhc2VJbnNlbnNpdGl2ZSxcbiAgICAgICAgICBleHBsYWluLFxuICAgICAgICAgIGNvbW1lbnQsXG4gICAgICAgIH0pXG4gICAgICApXG4gICAgICAudGhlbihvYmplY3RzID0+IHtcbiAgICAgICAgaWYgKGV4cGxhaW4pIHtcbiAgICAgICAgICByZXR1cm4gb2JqZWN0cztcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gb2JqZWN0cy5tYXAob2JqZWN0ID0+IG1vbmdvT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKSk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgZW5zdXJlSW5kZXgoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIGZpZWxkTmFtZXM6IHN0cmluZ1tdLFxuICAgIGluZGV4TmFtZTogP3N0cmluZyxcbiAgICBjYXNlSW5zZW5zaXRpdmU6IGJvb2xlYW4gPSBmYWxzZSxcbiAgICBvcHRpb25zPzogT2JqZWN0ID0ge31cbiAgKTogUHJvbWlzZTxhbnk+IHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgaW5kZXhDcmVhdGlvblJlcXVlc3QgPSB7fTtcbiAgICBjb25zdCBtb25nb0ZpZWxkTmFtZXMgPSBmaWVsZE5hbWVzLm1hcChmaWVsZE5hbWUgPT4gdHJhbnNmb3JtS2V5KGNsYXNzTmFtZSwgZmllbGROYW1lLCBzY2hlbWEpKTtcbiAgICBtb25nb0ZpZWxkTmFtZXMuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgaW5kZXhDcmVhdGlvblJlcXVlc3RbZmllbGROYW1lXSA9IG9wdGlvbnMuaW5kZXhUeXBlICE9PSB1bmRlZmluZWQgPyBvcHRpb25zLmluZGV4VHlwZSA6IDE7XG4gICAgfSk7XG5cbiAgICBjb25zdCBkZWZhdWx0T3B0aW9uczogT2JqZWN0ID0geyBiYWNrZ3JvdW5kOiB0cnVlLCBzcGFyc2U6IHRydWUgfTtcbiAgICBjb25zdCBpbmRleE5hbWVPcHRpb25zOiBPYmplY3QgPSBpbmRleE5hbWUgPyB7IG5hbWU6IGluZGV4TmFtZSB9IDoge307XG4gICAgY29uc3QgdHRsT3B0aW9uczogT2JqZWN0ID0gb3B0aW9ucy50dGwgIT09IHVuZGVmaW5lZCA/IHsgZXhwaXJlQWZ0ZXJTZWNvbmRzOiBvcHRpb25zLnR0bCB9IDoge307XG4gICAgY29uc3Qgc3BhcnNlT3B0aW9uczogT2JqZWN0ID0gb3B0aW9ucy5zcGFyc2UgIT09IHVuZGVmaW5lZCA/IHsgc3BhcnNlOiBvcHRpb25zLnNwYXJzZSB9IDoge307XG4gICAgY29uc3QgY2FzZUluc2Vuc2l0aXZlT3B0aW9uczogT2JqZWN0ID0gY2FzZUluc2Vuc2l0aXZlXG4gICAgICA/IHsgY29sbGF0aW9uOiBNb25nb0NvbGxlY3Rpb24uY2FzZUluc2Vuc2l0aXZlQ29sbGF0aW9uKCkgfVxuICAgICAgOiB7fTtcbiAgICBjb25zdCBwYXJ0aWFsRmlsdGVyT3B0aW9uczogT2JqZWN0ID1cbiAgICAgIG9wdGlvbnMucGFydGlhbEZpbHRlckV4cHJlc3Npb24gIT09IHVuZGVmaW5lZFxuICAgICAgICA/IHsgcGFydGlhbEZpbHRlckV4cHJlc3Npb246IG9wdGlvbnMucGFydGlhbEZpbHRlckV4cHJlc3Npb24gfVxuICAgICAgICA6IHt9O1xuICAgIGNvbnN0IGluZGV4T3B0aW9uczogT2JqZWN0ID0ge1xuICAgICAgLi4uZGVmYXVsdE9wdGlvbnMsXG4gICAgICAuLi5jYXNlSW5zZW5zaXRpdmVPcHRpb25zLFxuICAgICAgLi4uaW5kZXhOYW1lT3B0aW9ucyxcbiAgICAgIC4uLnR0bE9wdGlvbnMsXG4gICAgICAuLi5zcGFyc2VPcHRpb25zLFxuICAgICAgLi4ucGFydGlhbEZpbHRlck9wdGlvbnMsXG4gICAgfTtcblxuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uY3JlYXRlSW5kZXgoaW5kZXhDcmVhdGlvblJlcXVlc3QsIGluZGV4T3B0aW9ucylcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIENyZWF0ZSBhIHVuaXF1ZSBpbmRleC4gVW5pcXVlIGluZGV4ZXMgb24gbnVsbGFibGUgZmllbGRzIGFyZSBub3QgYWxsb3dlZC4gU2luY2Ugd2UgZG9uJ3RcbiAgLy8gY3VycmVudGx5IGtub3cgd2hpY2ggZmllbGRzIGFyZSBudWxsYWJsZSBhbmQgd2hpY2ggYXJlbid0LCB3ZSBpZ25vcmUgdGhhdCBjcml0ZXJpYS5cbiAgLy8gQXMgc3VjaCwgd2Ugc2hvdWxkbid0IGV4cG9zZSB0aGlzIGZ1bmN0aW9uIHRvIHVzZXJzIG9mIHBhcnNlIHVudGlsIHdlIGhhdmUgYW4gb3V0LW9mLWJhbmRcbiAgLy8gV2F5IG9mIGRldGVybWluaW5nIGlmIGEgZmllbGQgaXMgbnVsbGFibGUuIFVuZGVmaW5lZCBkb2Vzbid0IGNvdW50IGFnYWluc3QgdW5pcXVlbmVzcyxcbiAgLy8gd2hpY2ggaXMgd2h5IHdlIHVzZSBzcGFyc2UgaW5kZXhlcy5cbiAgZW5zdXJlVW5pcXVlbmVzcyhjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBmaWVsZE5hbWVzOiBzdHJpbmdbXSkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBpbmRleENyZWF0aW9uUmVxdWVzdCA9IHt9O1xuICAgIGNvbnN0IG1vbmdvRmllbGROYW1lcyA9IGZpZWxkTmFtZXMubWFwKGZpZWxkTmFtZSA9PiB0cmFuc2Zvcm1LZXkoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHNjaGVtYSkpO1xuICAgIG1vbmdvRmllbGROYW1lcy5mb3JFYWNoKGZpZWxkTmFtZSA9PiB7XG4gICAgICBpbmRleENyZWF0aW9uUmVxdWVzdFtmaWVsZE5hbWVdID0gMTtcbiAgICB9KTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5fZW5zdXJlU3BhcnNlVW5pcXVlSW5kZXhJbkJhY2tncm91bmQoaW5kZXhDcmVhdGlvblJlcXVlc3QpKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IDExMDAwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICAgJ1RyaWVkIHRvIGVuc3VyZSBmaWVsZCB1bmlxdWVuZXNzIGZvciBhIGNsYXNzIHRoYXQgYWxyZWFkeSBoYXMgZHVwbGljYXRlcy4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBDcmVhdGVzIGEgdW5pcXVlIHNwYXJzZSBpbmRleCBvbiBfYXV0aF9kYXRhXzxwcm92aWRlcj4uaWQgdG8gcHJldmVudFxuICAvLyByYWNlIGNvbmRpdGlvbnMgZHVyaW5nIGNvbmN1cnJlbnQgc2lnbnVwcyB3aXRoIHRoZSBzYW1lIGF1dGhEYXRhLlxuICBlbnN1cmVBdXRoRGF0YVVuaXF1ZW5lc3MocHJvdmlkZXI6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oJ19Vc2VyJylcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT5cbiAgICAgICAgY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLmNyZWF0ZUluZGV4KFxuICAgICAgICAgIHsgW2BfYXV0aF9kYXRhXyR7cHJvdmlkZXJ9LmlkYF06IDEgfSxcbiAgICAgICAgICB7IHVuaXF1ZTogdHJ1ZSwgc3BhcnNlOiB0cnVlLCBiYWNrZ3JvdW5kOiB0cnVlLCBuYW1lOiBgX2F1dGhfZGF0YV8ke3Byb3ZpZGVyfV9pZGAgfVxuICAgICAgICApXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gMTEwMDApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsXG4gICAgICAgICAgICAnVHJpZWQgdG8gZW5zdXJlIGZpZWxkIHVuaXF1ZW5lc3MgZm9yIGEgY2xhc3MgdGhhdCBhbHJlYWR5IGhhcyBkdXBsaWNhdGVzLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIC8vIElnbm9yZSBcImluZGV4IGFscmVhZHkgZXhpc3RzIHdpdGggc2FtZSBuYW1lXCIgb3IgXCJpbmRleCBhbHJlYWR5IGV4aXN0cyB3aXRoIGRpZmZlcmVudCBvcHRpb25zXCJcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IDg1IHx8IGVycm9yLmNvZGUgPT09IDg2KSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIFVzZWQgaW4gdGVzdHNcbiAgX3Jhd0ZpbmQoY2xhc3NOYW1lOiBzdHJpbmcsIHF1ZXJ5OiBRdWVyeVR5cGUpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT5cbiAgICAgICAgY29sbGVjdGlvbi5maW5kKHF1ZXJ5LCB7XG4gICAgICAgICAgbWF4VGltZU1TOiB0aGlzLl9tYXhUaW1lTVMsXG4gICAgICAgICAgYmF0Y2hTaXplOiB0aGlzLl9iYXRjaFNpemUsXG4gICAgICAgIH0pXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBFeGVjdXRlcyBhIGNvdW50LlxuICBjb3VudChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICByZWFkUHJlZmVyZW5jZTogP3N0cmluZyxcbiAgICBfZXN0aW1hdGU6ID9ib29sZWFuLFxuICAgIGhpbnQ6ID9taXhlZCxcbiAgICBjb21tZW50OiA/c3RyaW5nXG4gICkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICByZWFkUHJlZmVyZW5jZSA9IHRoaXMuX3BhcnNlUmVhZFByZWZlcmVuY2UocmVhZFByZWZlcmVuY2UpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLmNvdW50KHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSwgdHJ1ZSksIHtcbiAgICAgICAgICBtYXhUaW1lTVM6IHRoaXMuX21heFRpbWVNUyxcbiAgICAgICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgICAgICBoaW50LFxuICAgICAgICAgIGNvbW1lbnQsXG4gICAgICAgIH0pXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBkaXN0aW5jdChjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBxdWVyeTogUXVlcnlUeXBlLCBmaWVsZE5hbWU6IHN0cmluZykge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBpc1BvaW50ZXJGaWVsZCA9IHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1BvaW50ZXInO1xuICAgIGNvbnN0IHRyYW5zZm9ybUZpZWxkID0gdHJhbnNmb3JtS2V5KGNsYXNzTmFtZSwgZmllbGROYW1lLCBzY2hlbWEpO1xuXG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+XG4gICAgICAgIGNvbGxlY3Rpb24uZGlzdGluY3QodHJhbnNmb3JtRmllbGQsIHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSkpXG4gICAgICApXG4gICAgICAudGhlbihvYmplY3RzID0+IHtcbiAgICAgICAgb2JqZWN0cyA9IG9iamVjdHMuZmlsdGVyKG9iaiA9PiBvYmogIT0gbnVsbCk7XG4gICAgICAgIHJldHVybiBvYmplY3RzLm1hcChvYmplY3QgPT4ge1xuICAgICAgICAgIGlmIChpc1BvaW50ZXJGaWVsZCkge1xuICAgICAgICAgICAgcmV0dXJuIHRyYW5zZm9ybVBvaW50ZXJTdHJpbmcoc2NoZW1hLCBmaWVsZE5hbWUsIG9iamVjdCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBtb25nb09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lLCBvYmplY3QsIHNjaGVtYSk7XG4gICAgICAgIH0pO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGFnZ3JlZ2F0ZShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IGFueSxcbiAgICBwaXBlbGluZTogYW55LFxuICAgIHJlYWRQcmVmZXJlbmNlOiA/c3RyaW5nLFxuICAgIGhpbnQ6ID9taXhlZCxcbiAgICBleHBsYWluPzogYm9vbGVhbixcbiAgICBjb21tZW50OiA/c3RyaW5nLFxuICAgIHJhd1ZhbHVlcz86IGJvb2xlYW4sXG4gICAgcmF3RmllbGROYW1lcz86IGJvb2xlYW5cbiAgKSB7XG4gICAgdmFsaWRhdGVFeHBsYWluVmFsdWUoZXhwbGFpbik7XG4gICAgaWYgKHJhd1ZhbHVlcykge1xuICAgICAgcGlwZWxpbmUgPSBFSlNPTi5kZXNlcmlhbGl6ZShwaXBlbGluZSk7XG4gICAgfVxuICAgIGxldCBpc1BvaW50ZXJGaWVsZCA9IGZhbHNlO1xuICAgIHBpcGVsaW5lID0gcGlwZWxpbmUubWFwKHN0YWdlID0+IHtcbiAgICAgIGlmIChzdGFnZS4kZ3JvdXApIHtcbiAgICAgICAgc3RhZ2UuJGdyb3VwID0gdGhpcy5fcGFyc2VBZ2dyZWdhdGVHcm91cEFyZ3Moc2NoZW1hLCBzdGFnZS4kZ3JvdXAsIHJhd0ZpZWxkTmFtZXMpO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgc3RhZ2UuJGdyb3VwLl9pZCAmJlxuICAgICAgICAgIHR5cGVvZiBzdGFnZS4kZ3JvdXAuX2lkID09PSAnc3RyaW5nJyAmJlxuICAgICAgICAgIHN0YWdlLiRncm91cC5faWQuaW5kZXhPZignJF9wXycpID49IDBcbiAgICAgICAgKSB7XG4gICAgICAgICAgaXNQb2ludGVyRmllbGQgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoc3RhZ2UuJG1hdGNoKSB7XG4gICAgICAgIHN0YWdlLiRtYXRjaCA9IHRoaXMuX3BhcnNlQWdncmVnYXRlQXJncyhzY2hlbWEsIHN0YWdlLiRtYXRjaCwgcmF3VmFsdWVzLCByYXdGaWVsZE5hbWVzKTtcbiAgICAgIH1cbiAgICAgIGlmIChzdGFnZS4kcHJvamVjdCkge1xuICAgICAgICBzdGFnZS4kcHJvamVjdCA9IHRoaXMuX3BhcnNlQWdncmVnYXRlUHJvamVjdEFyZ3Moc2NoZW1hLCBzdGFnZS4kcHJvamVjdCwgcmF3VmFsdWVzLCByYXdGaWVsZE5hbWVzKTtcbiAgICAgIH1cbiAgICAgIGlmIChzdGFnZS4kZ2VvTmVhciAmJiBzdGFnZS4kZ2VvTmVhci5xdWVyeSkge1xuICAgICAgICBzdGFnZS4kZ2VvTmVhci5xdWVyeSA9IHRoaXMuX3BhcnNlQWdncmVnYXRlQXJncyhzY2hlbWEsIHN0YWdlLiRnZW9OZWFyLnF1ZXJ5LCByYXdWYWx1ZXMsIHJhd0ZpZWxkTmFtZXMpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHN0YWdlO1xuICAgIH0pO1xuICAgIHJlYWRQcmVmZXJlbmNlID0gdGhpcy5fcGFyc2VSZWFkUHJlZmVyZW5jZShyZWFkUHJlZmVyZW5jZSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+XG4gICAgICAgIGNvbGxlY3Rpb24uYWdncmVnYXRlKHBpcGVsaW5lLCB7XG4gICAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICAgICAgbWF4VGltZU1TOiB0aGlzLl9tYXhUaW1lTVMsXG4gICAgICAgICAgYmF0Y2hTaXplOiB0aGlzLl9iYXRjaFNpemUsXG4gICAgICAgICAgaGludCxcbiAgICAgICAgICBleHBsYWluLFxuICAgICAgICAgIGNvbW1lbnQsXG4gICAgICAgIH0pXG4gICAgICApXG4gICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgaWYgKHJhd0ZpZWxkTmFtZXMpIHtcbiAgICAgICAgICByZXR1cm4gcmVzdWx0cztcbiAgICAgICAgfVxuICAgICAgICByZXN1bHRzLmZvckVhY2gocmVzdWx0ID0+IHtcbiAgICAgICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlc3VsdCwgJ19pZCcpKSB7XG4gICAgICAgICAgICBpZiAoaXNQb2ludGVyRmllbGQgJiYgcmVzdWx0Ll9pZCkge1xuICAgICAgICAgICAgICByZXN1bHQuX2lkID0gcmVzdWx0Ll9pZC5zcGxpdCgnJCcpWzFdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICByZXN1bHQuX2lkID09IG51bGwgfHxcbiAgICAgICAgICAgICAgcmVzdWx0Ll9pZCA9PSB1bmRlZmluZWQgfHxcbiAgICAgICAgICAgICAgKFsnb2JqZWN0JywgJ3N0cmluZyddLmluY2x1ZGVzKHR5cGVvZiByZXN1bHQuX2lkKSAmJiBfLmlzRW1wdHkocmVzdWx0Ll9pZCkpXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgcmVzdWx0Ll9pZCA9IG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXN1bHQub2JqZWN0SWQgPSByZXN1bHQuX2lkO1xuICAgICAgICAgICAgZGVsZXRlIHJlc3VsdC5faWQ7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICB9KVxuICAgICAgLnRoZW4ob2JqZWN0cyA9PiB7XG4gICAgICAgIGlmIChyYXdWYWx1ZXMpIHtcbiAgICAgICAgICByZXR1cm4gb2JqZWN0cy5tYXAob2JqID0+IEVKU09OLnNlcmlhbGl6ZShvYmopKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmF3RmllbGROYW1lcykge1xuICAgICAgICAgIHJldHVybiBvYmplY3RzO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBvYmplY3RzLm1hcChvYmplY3QgPT4gbW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0KGNsYXNzTmFtZSwgb2JqZWN0LCBzY2hlbWEpKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBUaGlzIGZ1bmN0aW9uIHdpbGwgcmVjdXJzaXZlbHkgdHJhdmVyc2UgdGhlIHBpcGVsaW5lIGFuZCBjb252ZXJ0IGFueSBQb2ludGVyIGNvbHVtbnMuXG4gIC8vIElmIHdlIGRldGVjdCBhIHBvaW50ZXIgY29sdW1uIHdlIHdpbGwgcmVuYW1lIHRoZSBjb2x1bW4gYmVpbmcgcXVlcmllZCBmb3IgdG8gbWF0Y2ggdGhlIGNvbHVtblxuICAvLyBpbiB0aGUgZGF0YWJhc2UuIFdlIGFsc28gbW9kaWZ5IHRoZSB2YWx1ZSB0byB3aGF0IHdlIGV4cGVjdCB0aGUgdmFsdWUgdG8gYmUgaW4gdGhlIGRhdGFiYXNlXG4gIC8vIGFzIHdlbGwuXG4gIC8vIEZvciBkYXRlcywgdGhlIGRyaXZlciBleHBlY3RzIGEgRGF0ZSBvYmplY3QsIGJ1dCB3ZSBoYXZlIGEgc3RyaW5nIGNvbWluZyBpbi4gU28gd2UnbGwgY29udmVydFxuICAvLyB0aGUgc3RyaW5nIHRvIGEgRGF0ZSBzbyB0aGUgZHJpdmVyIGNhbiBwZXJmb3JtIHRoZSBuZWNlc3NhcnkgY29tcGFyaXNvbi5cbiAgLy9cbiAgLy8gVGhlIGdvYWwgb2YgdGhpcyBtZXRob2QgaXMgdG8gbG9vayBmb3IgdGhlIFwibGVhdmVzXCIgb2YgdGhlIHBpcGVsaW5lIGFuZCBkZXRlcm1pbmUgaWYgaXQgbmVlZHNcbiAgLy8gdG8gYmUgY29udmVydGVkLiBUaGUgcGlwZWxpbmUgY2FuIGhhdmUgYSBmZXcgZGlmZmVyZW50IGZvcm1zLiBGb3IgbW9yZSBkZXRhaWxzLCBzZWU6XG4gIC8vICAgICBodHRwczovL2RvY3MubW9uZ29kYi5jb20vbWFudWFsL3JlZmVyZW5jZS9vcGVyYXRvci9hZ2dyZWdhdGlvbi9cbiAgLy9cbiAgLy8gSWYgdGhlIHBpcGVsaW5lIGlzIGFuIGFycmF5LCBpdCBtZWFucyB3ZSBhcmUgcHJvYmFibHkgcGFyc2luZyBhbiAnJGFuZCcgb3IgJyRvcicgb3BlcmF0b3IuIEluXG4gIC8vIHRoYXQgY2FzZSB3ZSBuZWVkIHRvIGxvb3AgdGhyb3VnaCBhbGwgb2YgaXQncyBjaGlsZHJlbiB0byBmaW5kIHRoZSBjb2x1bW5zIGJlaW5nIG9wZXJhdGVkIG9uLlxuICAvLyBJZiB0aGUgcGlwZWxpbmUgaXMgYW4gb2JqZWN0LCB0aGVuIHdlJ2xsIGxvb3AgdGhyb3VnaCB0aGUga2V5cyBjaGVja2luZyB0byBzZWUgaWYgdGhlIGtleSBuYW1lXG4gIC8vIG1hdGNoZXMgb25lIG9mIHRoZSBzY2hlbWEgY29sdW1ucy4gSWYgaXQgZG9lcyBtYXRjaCBhIFBvaW50ZXIgY29sdW1uLCB0aGVuIHdlJ2xsIGNvbnZlcnQgdGhlXG4gIC8vIHZhbHVlIGFzIGRlc2NyaWJlZCBhYm92ZS4gRGF0ZSB2YWx1ZXMgYXJlIGxlZnQgdW50b3VjaGVkIHRvIGF2b2lkIGNvcnJ1cHRpbmcgbmF0aXZlIE1vbmdvREJcbiAgLy8gYWdncmVnYXRpb24gZXhwcmVzc2lvbnMuXG4gIC8vXG4gIC8vIEFzIG11Y2ggYXMgSSBoYXRlIHJlY3Vyc2lvbi4uLnRoaXMgc2VlbWVkIGxpa2UgYSBnb29kIGZpdCBmb3IgaXQuIFdlJ3JlIGVzc2VudGlhbGx5IHRyYXZlcnNpbmdcbiAgLy8gZG93biBhIHRyZWUgdG8gZmluZCBhIFwibGVhZiBub2RlXCIgYW5kIGNoZWNraW5nIHRvIHNlZSBpZiBpdCBuZWVkcyB0byBiZSBjb252ZXJ0ZWQuXG4gIF9wYXJzZUFnZ3JlZ2F0ZUFyZ3Moc2NoZW1hOiBhbnksIHBpcGVsaW5lOiBhbnksIHJhd1ZhbHVlcz86IGJvb2xlYW4sIHJhd0ZpZWxkTmFtZXM/OiBib29sZWFuKTogYW55IHtcbiAgICBpZiAocGlwZWxpbmUgPT09IG51bGwpIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH0gZWxzZSBpZiAoVXRpbHMuaXNEYXRlKHBpcGVsaW5lKSkge1xuICAgICAgcmV0dXJuIHBpcGVsaW5lO1xuICAgIH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheShwaXBlbGluZSkpIHtcbiAgICAgIHJldHVybiBwaXBlbGluZS5tYXAodmFsdWUgPT4gdGhpcy5fcGFyc2VBZ2dyZWdhdGVBcmdzKHNjaGVtYSwgdmFsdWUsIHJhd1ZhbHVlcywgcmF3RmllbGROYW1lcykpO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHBpcGVsaW5lID09PSAnb2JqZWN0Jykge1xuICAgICAgY29uc3QgcmV0dXJuVmFsdWUgPSB7fTtcbiAgICAgIGZvciAoY29uc3QgZmllbGQgaW4gcGlwZWxpbmUpIHtcbiAgICAgICAgaWYgKCFyYXdGaWVsZE5hbWVzICYmIHNjaGVtYS5maWVsZHNbZmllbGRdICYmIHNjaGVtYS5maWVsZHNbZmllbGRdLnR5cGUgPT09ICdQb2ludGVyJykge1xuICAgICAgICAgIGlmICh0eXBlb2YgcGlwZWxpbmVbZmllbGRdID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgcmV0dXJuVmFsdWVbYF9wXyR7ZmllbGR9YF0gPSBwaXBlbGluZVtmaWVsZF07XG4gICAgICAgICAgfSBlbHNlIGlmIChyYXdWYWx1ZXMpIHtcbiAgICAgICAgICAgIHJldHVyblZhbHVlW2BfcF8ke2ZpZWxkfWBdID0gcGlwZWxpbmVbZmllbGRdO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm5WYWx1ZVtgX3BfJHtmaWVsZH1gXSA9IGAke3NjaGVtYS5maWVsZHNbZmllbGRdLnRhcmdldENsYXNzfSQke3BpcGVsaW5lW2ZpZWxkXX1gO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXR1cm5WYWx1ZVtmaWVsZF0gPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUFyZ3Moc2NoZW1hLCBwaXBlbGluZVtmaWVsZF0sIHJhd1ZhbHVlcywgcmF3RmllbGROYW1lcyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXJhd0ZpZWxkTmFtZXMpIHtcbiAgICAgICAgICBpZiAoZmllbGQgPT09ICdvYmplY3RJZCcpIHtcbiAgICAgICAgICAgIHJldHVyblZhbHVlWydfaWQnXSA9IHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgICAgIGRlbGV0ZSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gJ2NyZWF0ZWRBdCcpIHtcbiAgICAgICAgICAgIHJldHVyblZhbHVlWydfY3JlYXRlZF9hdCddID0gcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICAgICAgZGVsZXRlIHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkID09PSAndXBkYXRlZEF0Jykge1xuICAgICAgICAgICAgcmV0dXJuVmFsdWVbJ191cGRhdGVkX2F0J10gPSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgICAgICBkZWxldGUgcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIHJldHVyblZhbHVlO1xuICAgIH1cbiAgICByZXR1cm4gcGlwZWxpbmU7XG4gIH1cblxuICAvLyBUaGlzIGZ1bmN0aW9uIGlzIHNsaWdodGx5IGRpZmZlcmVudCB0aGFuIHRoZSBvbmUgYWJvdmUuIFJhdGhlciB0aGFuIHRyeWluZyB0byBjb21iaW5lIHRoZXNlXG4gIC8vIHR3byBmdW5jdGlvbnMgYW5kIG1ha2luZyB0aGUgY29kZSBldmVuIGhhcmRlciB0byB1bmRlcnN0YW5kLCBJIGRlY2lkZWQgdG8gc3BsaXQgaXQgdXAuIFRoZVxuICAvLyBkaWZmZXJlbmNlIHdpdGggdGhpcyBmdW5jdGlvbiBpcyB3ZSBhcmUgbm90IHRyYW5zZm9ybWluZyB0aGUgdmFsdWVzLCBvbmx5IHRoZSBrZXlzIG9mIHRoZVxuICAvLyBwaXBlbGluZS5cbiAgX3BhcnNlQWdncmVnYXRlUHJvamVjdEFyZ3Moc2NoZW1hOiBhbnksIHBpcGVsaW5lOiBhbnksIHJhd1ZhbHVlcz86IGJvb2xlYW4sIHJhd0ZpZWxkTmFtZXM/OiBib29sZWFuKTogYW55IHtcbiAgICBjb25zdCByZXR1cm5WYWx1ZSA9IHt9O1xuICAgIGZvciAoY29uc3QgZmllbGQgaW4gcGlwZWxpbmUpIHtcbiAgICAgIGlmICghcmF3RmllbGROYW1lcyAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgcmV0dXJuVmFsdWVbYF9wXyR7ZmllbGR9YF0gPSBwaXBlbGluZVtmaWVsZF07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm5WYWx1ZVtmaWVsZF0gPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUFyZ3Moc2NoZW1hLCBwaXBlbGluZVtmaWVsZF0sIHJhd1ZhbHVlcywgcmF3RmllbGROYW1lcyk7XG4gICAgICB9XG5cbiAgICAgIGlmICghcmF3RmllbGROYW1lcykge1xuICAgICAgICBpZiAoZmllbGQgPT09ICdvYmplY3RJZCcpIHtcbiAgICAgICAgICByZXR1cm5WYWx1ZVsnX2lkJ10gPSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgICAgZGVsZXRlIHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gJ2NyZWF0ZWRBdCcpIHtcbiAgICAgICAgICByZXR1cm5WYWx1ZVsnX2NyZWF0ZWRfYXQnXSA9IHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgICBkZWxldGUgcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICB9IGVsc2UgaWYgKGZpZWxkID09PSAndXBkYXRlZEF0Jykge1xuICAgICAgICAgIHJldHVyblZhbHVlWydfdXBkYXRlZF9hdCddID0gcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICAgIGRlbGV0ZSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJldHVyblZhbHVlO1xuICB9XG5cbiAgLy8gVGhpcyBmdW5jdGlvbiBpcyBzbGlnaHRseSBkaWZmZXJlbnQgdGhhbiB0aGUgdHdvIGFib3ZlLiBNb25nb0RCICRncm91cCBhZ2dyZWdhdGUgbG9va3MgbGlrZTpcbiAgLy8gICAgIHsgJGdyb3VwOiB7IF9pZDogPGV4cHJlc3Npb24+LCA8ZmllbGQxPjogeyA8YWNjdW11bGF0b3IxPiA6IDxleHByZXNzaW9uMT4gfSwgLi4uIH0gfVxuICAvLyBUaGUgPGV4cHJlc3Npb24+IGNvdWxkIGJlIGEgY29sdW1uIG5hbWUsIHByZWZpeGVkIHdpdGggdGhlICckJyBjaGFyYWN0ZXIuIFdlJ2xsIGxvb2sgZm9yXG4gIC8vIHRoZXNlIDxleHByZXNzaW9uPiBhbmQgY2hlY2sgdG8gc2VlIGlmIGl0IGlzIGEgJ1BvaW50ZXInIG9yIGlmIGl0J3Mgb25lIG9mIGNyZWF0ZWRBdCxcbiAgLy8gdXBkYXRlZEF0IG9yIG9iamVjdElkIGFuZCBjaGFuZ2UgaXQgYWNjb3JkaW5nbHkuXG4gIF9wYXJzZUFnZ3JlZ2F0ZUdyb3VwQXJncyhzY2hlbWE6IGFueSwgcGlwZWxpbmU6IGFueSwgcmF3RmllbGROYW1lcz86IGJvb2xlYW4pOiBhbnkge1xuICAgIGlmIChBcnJheS5pc0FycmF5KHBpcGVsaW5lKSkge1xuICAgICAgcmV0dXJuIHBpcGVsaW5lLm1hcCh2YWx1ZSA9PiB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUdyb3VwQXJncyhzY2hlbWEsIHZhbHVlLCByYXdGaWVsZE5hbWVzKSk7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgcGlwZWxpbmUgPT09ICdvYmplY3QnKSB7XG4gICAgICBjb25zdCByZXR1cm5WYWx1ZSA9IHt9O1xuICAgICAgZm9yIChjb25zdCBmaWVsZCBpbiBwaXBlbGluZSkge1xuICAgICAgICByZXR1cm5WYWx1ZVtmaWVsZF0gPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUdyb3VwQXJncyhzY2hlbWEsIHBpcGVsaW5lW2ZpZWxkXSwgcmF3RmllbGROYW1lcyk7XG4gICAgICB9XG4gICAgICByZXR1cm4gcmV0dXJuVmFsdWU7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgcGlwZWxpbmUgPT09ICdzdHJpbmcnICYmICFyYXdGaWVsZE5hbWVzKSB7XG4gICAgICBjb25zdCBmaWVsZCA9IHBpcGVsaW5lLnN1YnN0cmluZygxKTtcbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgcmV0dXJuIGAkX3BfJHtmaWVsZH1gO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PSAnY3JlYXRlZEF0Jykge1xuICAgICAgICByZXR1cm4gJyRfY3JlYXRlZF9hdCc7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkID09ICd1cGRhdGVkQXQnKSB7XG4gICAgICAgIHJldHVybiAnJF91cGRhdGVkX2F0JztcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHBpcGVsaW5lO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlY3Vyc2l2ZWx5IGNvbnZlcnRzIHZhbHVlcyB0byBEYXRlIG9iamVjdHMuIFNpbmNlIHRoZSBwYXNzZWQgb2JqZWN0IGlzIHBhcnQgb2YgYW4gYWdncmVnYXRpb25cbiAgICogcGlwZWxpbmUgYW5kIGNhbiBjb250YWluIHZhcmlvdXMgbG9naWMgb3BlcmF0b3JzIChsaWtlICRndCwgJGx0LCBldGMpLCB0aGlzIGZ1bmN0aW9uIHdpbGxcbiAgICogdHJhdmVyc2UgdGhlIG9iamVjdCBhbmQgY29udmVydCBhbnkgc3RyaW5ncyB0aGF0IGNhbiBiZSBwYXJzZWQgYXMgZGF0ZXMgaW50byBEYXRlIG9iamVjdHMuXG4gICAqIEBwYXJhbSB7YW55fSB2YWx1ZSBUaGUgdmFsdWUgdG8gY29udmVydC5cbiAgICogQHJldHVybnMge2FueX0gVGhlIG9yaWdpbmFsIHZhbHVlIGlmIG5vdCBjb252ZXJ0aWJsZSB0byBEYXRlLCBvciBhIERhdGUgb2JqZWN0IGlmIGl0IGlzLlxuICAgKi9cbiAgX2NvbnZlcnRUb0RhdGUodmFsdWU6IGFueSk6IGFueSB7XG4gICAgaWYgKFV0aWxzLmlzRGF0ZSh2YWx1ZSkpIHtcbiAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHJldHVybiBpc05hTihEYXRlLnBhcnNlKHZhbHVlKSkgPyB2YWx1ZSA6IG5ldyBEYXRlKHZhbHVlKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgIGNvbnN0IHJldHVyblZhbHVlID0ge307XG4gICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHZhbHVlKSB7XG4gICAgICAgIHJldHVyblZhbHVlW2ZpZWxkXSA9IHRoaXMuX2NvbnZlcnRUb0RhdGUodmFsdWVbZmllbGRdKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXR1cm5WYWx1ZTtcbiAgICB9XG4gICAgcmV0dXJuIHZhbHVlO1xuICB9XG5cbiAgX3BhcnNlUmVhZFByZWZlcmVuY2UocmVhZFByZWZlcmVuY2U6ID9zdHJpbmcpOiA/c3RyaW5nIHtcbiAgICBpZiAocmVhZFByZWZlcmVuY2UpIHtcbiAgICAgIHJlYWRQcmVmZXJlbmNlID0gcmVhZFByZWZlcmVuY2UudG9VcHBlckNhc2UoKTtcbiAgICB9XG4gICAgc3dpdGNoIChyZWFkUHJlZmVyZW5jZSkge1xuICAgICAgY2FzZSAnUFJJTUFSWSc6XG4gICAgICAgIHJlYWRQcmVmZXJlbmNlID0gUmVhZFByZWZlcmVuY2UuUFJJTUFSWTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdQUklNQVJZX1BSRUZFUlJFRCc6XG4gICAgICAgIHJlYWRQcmVmZXJlbmNlID0gUmVhZFByZWZlcmVuY2UuUFJJTUFSWV9QUkVGRVJSRUQ7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnU0VDT05EQVJZJzpcbiAgICAgICAgcmVhZFByZWZlcmVuY2UgPSBSZWFkUHJlZmVyZW5jZS5TRUNPTkRBUlk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnU0VDT05EQVJZX1BSRUZFUlJFRCc6XG4gICAgICAgIHJlYWRQcmVmZXJlbmNlID0gUmVhZFByZWZlcmVuY2UuU0VDT05EQVJZX1BSRUZFUlJFRDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdORUFSRVNUJzpcbiAgICAgICAgcmVhZFByZWZlcmVuY2UgPSBSZWFkUHJlZmVyZW5jZS5ORUFSRVNUO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgdW5kZWZpbmVkOlxuICAgICAgY2FzZSBudWxsOlxuICAgICAgY2FzZSAnJzpcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJ05vdCBzdXBwb3J0ZWQgcmVhZCBwcmVmZXJlbmNlLicpO1xuICAgIH1cbiAgICByZXR1cm4gcmVhZFByZWZlcmVuY2U7XG4gIH1cblxuICBwZXJmb3JtSW5pdGlhbGl6YXRpb24oKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgY3JlYXRlSW5kZXgoY2xhc3NOYW1lOiBzdHJpbmcsIGluZGV4OiBhbnkpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLmNyZWF0ZUluZGV4KGluZGV4KSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGNyZWF0ZUluZGV4ZXMoY2xhc3NOYW1lOiBzdHJpbmcsIGluZGV4ZXM6IGFueSkge1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uY3JlYXRlSW5kZXhlcyhpbmRleGVzKSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGNyZWF0ZUluZGV4ZXNJZk5lZWRlZChjbGFzc05hbWU6IHN0cmluZywgZmllbGROYW1lOiBzdHJpbmcsIHR5cGU6IGFueSkge1xuICAgIGlmICh0eXBlICYmIHR5cGUudHlwZSA9PT0gJ1BvbHlnb24nKSB7XG4gICAgICBjb25zdCBpbmRleCA9IHtcbiAgICAgICAgW2ZpZWxkTmFtZV06ICcyZHNwaGVyZScsXG4gICAgICB9O1xuICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlSW5kZXgoY2xhc3NOYW1lLCBpbmRleCk7XG4gICAgfVxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIGNyZWF0ZVRleHRJbmRleGVzSWZOZWVkZWQoY2xhc3NOYW1lOiBzdHJpbmcsIHF1ZXJ5OiBRdWVyeVR5cGUsIHNjaGVtYTogYW55KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgZm9yIChjb25zdCBmaWVsZE5hbWUgaW4gcXVlcnkpIHtcbiAgICAgIGlmICghcXVlcnlbZmllbGROYW1lXSB8fCAhcXVlcnlbZmllbGROYW1lXS4kdGV4dCkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGV4aXN0aW5nSW5kZXhlcyA9IHNjaGVtYS5pbmRleGVzO1xuICAgICAgZm9yIChjb25zdCBrZXkgaW4gZXhpc3RpbmdJbmRleGVzKSB7XG4gICAgICAgIGNvbnN0IGluZGV4ID0gZXhpc3RpbmdJbmRleGVzW2tleV07XG4gICAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoaW5kZXgsIGZpZWxkTmFtZSkpIHtcbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGNvbnN0IGluZGV4TmFtZSA9IGAke2ZpZWxkTmFtZX1fdGV4dGA7XG4gICAgICBjb25zdCB0ZXh0SW5kZXggPSB7XG4gICAgICAgIFtpbmRleE5hbWVdOiB7IFtmaWVsZE5hbWVdOiAndGV4dCcgfSxcbiAgICAgIH07XG4gICAgICByZXR1cm4gdGhpcy5zZXRJbmRleGVzV2l0aFNjaGVtYUZvcm1hdChcbiAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICB0ZXh0SW5kZXgsXG4gICAgICAgIGV4aXN0aW5nSW5kZXhlcyxcbiAgICAgICAgc2NoZW1hLmZpZWxkc1xuICAgICAgKS5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSA4NSkge1xuICAgICAgICAgIC8vIEluZGV4IGV4aXN0IHdpdGggZGlmZmVyZW50IG9wdGlvbnNcbiAgICAgICAgICByZXR1cm4gdGhpcy5zZXRJbmRleGVzRnJvbU1vbmdvKGNsYXNzTmFtZSk7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgZ2V0SW5kZXhlcyhjbGFzc05hbWU6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uaW5kZXhlcygpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgZHJvcEluZGV4KGNsYXNzTmFtZTogc3RyaW5nLCBpbmRleDogYW55KSB7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5kcm9wSW5kZXgoaW5kZXgpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgZHJvcEFsbEluZGV4ZXMoY2xhc3NOYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLmRyb3BJbmRleGVzKCkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICB1cGRhdGVTY2hlbWFXaXRoSW5kZXhlcygpOiBQcm9taXNlPGFueT4ge1xuICAgIHJldHVybiB0aGlzLmdldEFsbENsYXNzZXMoKVxuICAgICAgLnRoZW4oY2xhc3NlcyA9PiB7XG4gICAgICAgIGNvbnN0IHByb21pc2VzID0gY2xhc3Nlcy5tYXAoc2NoZW1hID0+IHtcbiAgICAgICAgICByZXR1cm4gdGhpcy5zZXRJbmRleGVzRnJvbU1vbmdvKHNjaGVtYS5jbGFzc05hbWUpO1xuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UuYWxsKHByb21pc2VzKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBjcmVhdGVUcmFuc2FjdGlvbmFsU2Vzc2lvbigpOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IHRyYW5zYWN0aW9uYWxTZWN0aW9uID0gdGhpcy5jbGllbnQuc3RhcnRTZXNzaW9uKCk7XG4gICAgdHJhbnNhY3Rpb25hbFNlY3Rpb24uc3RhcnRUcmFuc2FjdGlvbigpO1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUodHJhbnNhY3Rpb25hbFNlY3Rpb24pO1xuICB9XG5cbiAgY29tbWl0VHJhbnNhY3Rpb25hbFNlc3Npb24odHJhbnNhY3Rpb25hbFNlY3Rpb246IGFueSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGNvbW1pdCA9IHJldHJpZXMgPT4ge1xuICAgICAgcmV0dXJuIHRyYW5zYWN0aW9uYWxTZWN0aW9uXG4gICAgICAgIC5jb21taXRUcmFuc2FjdGlvbigpXG4gICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yICYmIGVycm9yLmhhc0Vycm9yTGFiZWwoJ1RyYW5zaWVudFRyYW5zYWN0aW9uRXJyb3InKSAmJiByZXRyaWVzID4gMCkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbW1pdChyZXRyaWVzIC0gMSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9KVxuICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgdHJhbnNhY3Rpb25hbFNlY3Rpb24uZW5kU2Vzc2lvbigpO1xuICAgICAgICB9KTtcbiAgICB9O1xuICAgIHJldHVybiBjb21taXQoNSk7XG4gIH1cblxuICBhYm9ydFRyYW5zYWN0aW9uYWxTZXNzaW9uKHRyYW5zYWN0aW9uYWxTZWN0aW9uOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gdHJhbnNhY3Rpb25hbFNlY3Rpb24uYWJvcnRUcmFuc2FjdGlvbigpLnRoZW4oKCkgPT4ge1xuICAgICAgdHJhbnNhY3Rpb25hbFNlY3Rpb24uZW5kU2Vzc2lvbigpO1xuICAgIH0pO1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IE1vbmdvU3RvcmFnZUFkYXB0ZXI7XG4iXSwibWFwcGluZ3MiOiI7Ozs7OztBQUNBLElBQUFBLFdBQUEsR0FBQUMsT0FBQTtBQUVBLElBQUFDLGVBQUEsR0FBQUQsT0FBQTtBQUNBLElBQUFFLE1BQUEsR0FBQUMsc0JBQUEsQ0FBQUgsT0FBQTtBQUNBLElBQUFJLGdCQUFBLEdBQUFELHNCQUFBLENBQUFILE9BQUE7QUFDQSxJQUFBSyxzQkFBQSxHQUFBRixzQkFBQSxDQUFBSCxPQUFBO0FBQ0EsSUFBQU0sZUFBQSxHQUFBTixPQUFBO0FBU0EsSUFBQU8sS0FBQSxHQUFBSixzQkFBQSxDQUFBSCxPQUFBO0FBRUEsSUFBQVEsT0FBQSxHQUFBTCxzQkFBQSxDQUFBSCxPQUFBO0FBQ0EsSUFBQVMsS0FBQSxHQUFBVCxPQUFBO0FBQ0EsSUFBQVUsU0FBQSxHQUFBQyx1QkFBQSxDQUFBWCxPQUFBO0FBQ0EsSUFBQVksT0FBQSxHQUFBVCxzQkFBQSxDQUFBSCxPQUFBO0FBQXFDLFNBQUFXLHdCQUFBRSxDQUFBLEVBQUFDLENBQUEsNkJBQUFDLE9BQUEs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