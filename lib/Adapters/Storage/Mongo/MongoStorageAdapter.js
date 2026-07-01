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
        w: 0,
        j: false
      }
    })).then(result => (0, _MongoTransform.mongoObjectToParseObject)(className, result.value, schema)).catch(error => {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbW9uZ29kYlVybCIsInJlcXVpcmUiLCJfU3RvcmFnZUFkYXB0ZXIiLCJfVXRpbHMiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwiX01vbmdvQ29sbGVjdGlvbiIsIl9Nb25nb1NjaGVtYUNvbGxlY3Rpb24iLCJfTW9uZ29UcmFuc2Zvcm0iLCJfbm9kZSIsIl9sb2Rhc2giLCJfYnNvbiIsIl9kZWZhdWx0cyIsIl9pbnRlcm9wUmVxdWlyZVdpbGRjYXJkIiwiX2xvZ2dlciIsImUiLCJ0IiwiV2Vha01hcCIsInIiLCJuIiwiX19lc01vZHVsZSIsIm8iLCJpIiwiZiIsIl9fcHJvdG9fXyIsImRlZmF1bHQiLCJoYXMiLCJnZXQiLCJzZXQiLCJoYXNPd25Qcm9wZXJ0eSIsImNhbGwiLCJPYmplY3QiLCJkZWZpbmVQcm9wZXJ0eSIsImdldE93blByb3BlcnR5RGVzY3JpcHRvciIsIm1vbmdvZGIiLCJNb25nb0NsaWVudCIsIlJlYWRQcmVmZXJlbmNlIiwiTW9uZ29TY2hlbWFDb2xsZWN0aW9uTmFtZSIsImlzVHJhbnNpZW50RXJyb3IiLCJlcnJvciIsInRyYW5zaWVudEVycm9yTmFtZXMiLCJpbmNsdWRlcyIsIm5hbWUiLCJoYXNFcnJvckxhYmVsIiwic3RvcmFnZUFkYXB0ZXJBbGxDb2xsZWN0aW9ucyIsIm1vbmdvQWRhcHRlciIsImNvbm5lY3QiLCJ0aGVuIiwiZGF0YWJhc2UiLCJjb2xsZWN0aW9ucyIsImZpbHRlciIsImNvbGxlY3Rpb24iLCJuYW1lc3BhY2UiLCJtYXRjaCIsImNvbGxlY3Rpb25OYW1lIiwiaW5kZXhPZiIsIl9jb2xsZWN0aW9uUHJlZml4IiwiY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYSIsInNjaGVtYSIsImZpZWxkcyIsIl9ycGVybSIsIl93cGVybSIsImNsYXNzTmFtZSIsIl9oYXNoZWRfcGFzc3dvcmQiLCJtb25nb1NjaGVtYUZyb21GaWVsZHNBbmRDbGFzc05hbWVBbmRDTFAiLCJjbGFzc0xldmVsUGVybWlzc2lvbnMiLCJpbmRleGVzIiwibW9uZ29PYmplY3QiLCJfaWQiLCJvYmplY3RJZCIsInVwZGF0ZWRBdCIsImNyZWF0ZWRBdCIsIl9tZXRhZGF0YSIsInVuZGVmaW5lZCIsImZpZWxkTmFtZSIsInR5cGUiLCJ0YXJnZXRDbGFzcyIsImZpZWxkT3B0aW9ucyIsIk1vbmdvU2NoZW1hQ29sbGVjdGlvbiIsInBhcnNlRmllbGRUeXBlVG9Nb25nb0ZpZWxkVHlwZSIsImtleXMiLCJsZW5ndGgiLCJmaWVsZHNfb3B0aW9ucyIsImNsYXNzX3Blcm1pc3Npb25zIiwidmFsaWRhdGVFeHBsYWluVmFsdWUiLCJleHBsYWluIiwiZXhwbGFpbkFsbG93ZWRWYWx1ZXMiLCJQYXJzZSIsIkVycm9yIiwiSU5WQUxJRF9RVUVSWSIsIk1vbmdvU3RvcmFnZUFkYXB0ZXIiLCJjb25zdHJ1Y3RvciIsInVyaSIsImRlZmF1bHRzIiwiRGVmYXVsdE1vbmdvVVJJIiwiY29sbGVjdGlvblByZWZpeCIsIm1vbmdvT3B0aW9ucyIsIl91cmkiLCJfb25jaGFuZ2UiLCJfbWF4VGltZU1TIiwibWF4VGltZU1TIiwiX2JhdGNoU2l6ZSIsImJhdGNoU2l6ZSIsImNhblNvcnRPbkpvaW5UYWJsZXMiLCJlbmFibGVTY2hlbWFIb29rcyIsInNjaGVtYUNhY2hlVHRsIiwiZGlzYWJsZUluZGV4RmllbGRWYWxpZGF0aW9uIiwiX2xvZ0NsaWVudEV2ZW50cyIsImxvZ0NsaWVudEV2ZW50cyIsIl9jbGllbnRNZXRhZGF0YSIsImNsaWVudE1ldGFkYXRhIiwiX21vbmdvT3B0aW9ucyIsImtleSIsIlBhcnNlU2VydmVyRGF0YWJhc2VPcHRpb25zIiwid2F0Y2giLCJjYWxsYmFjayIsImNvbm5lY3Rpb25Qcm9taXNlIiwiZW5jb2RlZFVyaSIsImZvcm1hdFVybCIsInBhcnNlVXJsIiwib3B0aW9ucyIsImRyaXZlckluZm8iLCJ2ZXJzaW9uIiwiY2xpZW50IiwicyIsImRiIiwiZGJOYW1lIiwib24iLCJBcnJheSIsImlzQXJyYXkiLCJmb3JFYWNoIiwiZXZlbnRDb25maWciLCJldmVudCIsImxvZ0RhdGEiLCJrZXlQYXRoIiwiXyIsImxvZ0xldmVsIiwibG9nZ2VyIiwibG9nTWVzc2FnZSIsIkpTT04iLCJzdHJpbmdpZnkiLCJVdGlscyIsImdldENpcmN1bGFyUmVwbGFjZXIiLCJjYXRjaCIsImVyciIsIlByb21pc2UiLCJyZWplY3QiLCJoYW5kbGVFcnJvciIsImNvZGUiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJoYW5kbGVTaHV0ZG93biIsImNsb3NlIiwiX2FkYXB0aXZlQ29sbGVjdGlvbiIsInJhd0NvbGxlY3Rpb24iLCJNb25nb0NvbGxlY3Rpb24iLCJfc2NoZW1hQ29sbGVjdGlvbiIsIl9zdHJlYW0iLCJfbW9uZ29Db2xsZWN0aW9uIiwiY2xhc3NFeGlzdHMiLCJsaXN0Q29sbGVjdGlvbnMiLCJ0b0FycmF5Iiwic2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zIiwiQ0xQcyIsInNjaGVtYUNvbGxlY3Rpb24iLCJ1cGRhdGVTY2hlbWEiLCIkc2V0Iiwic2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQiLCJzdWJtaXR0ZWRJbmRleGVzIiwiZXhpc3RpbmdJbmRleGVzIiwicmVzb2x2ZSIsIl9pZF8iLCJkZWxldGVQcm9taXNlcyIsImluc2VydGVkSW5kZXhlcyIsImZpZWxkIiwiX19vcCIsInByb21pc2UiLCJkcm9wSW5kZXgiLCJwdXNoIiwicHJvdG90eXBlIiwicmVwbGFjZSIsImluc2VydFByb21pc2UiLCJjcmVhdGVJbmRleGVzIiwiYWxsIiwic2V0SW5kZXhlc0Zyb21Nb25nbyIsImdldEluZGV4ZXMiLCJyZWR1Y2UiLCJvYmoiLCJpbmRleCIsIl9mdHMiLCJfZnRzeCIsIndlaWdodHMiLCJjcmVhdGVDbGFzcyIsImluc2VydFNjaGVtYSIsInVwZGF0ZUZpZWxkT3B0aW9ucyIsImFkZEZpZWxkSWZOb3RFeGlzdHMiLCJjcmVhdGVJbmRleGVzSWZOZWVkZWQiLCJkZWxldGVDbGFzcyIsImRyb3AiLCJtZXNzYWdlIiwiZmluZEFuZERlbGV0ZVNjaGVtYSIsImRlbGV0ZUFsbENsYXNzZXMiLCJmYXN0IiwibWFwIiwiZGVsZXRlTWFueSIsImRlbGV0ZUZpZWxkcyIsImZpZWxkTmFtZXMiLCJtb25nb0Zvcm1hdE5hbWVzIiwiY29sbGVjdGlvblVwZGF0ZSIsIiR1bnNldCIsImNvbGxlY3Rpb25GaWx0ZXIiLCIkb3IiLCIkZXhpc3RzIiwic2NoZW1hVXBkYXRlIiwidXBkYXRlTWFueSIsImdldEFsbENsYXNzZXMiLCJzY2hlbWFzQ29sbGVjdGlvbiIsIl9mZXRjaEFsbFNjaGVtYXNGcm9tX1NDSEVNQSIsImdldENsYXNzIiwiX2ZldGNoT25lU2NoZW1hRnJvbV9TQ0hFTUEiLCJjcmVhdGVPYmplY3QiLCJvYmplY3QiLCJ0cmFuc2FjdGlvbmFsU2Vzc2lvbiIsInBhcnNlT2JqZWN0VG9Nb25nb09iamVjdEZvckNyZWF0ZSIsImluc2VydE9uZSIsIm9wcyIsIkRVUExJQ0FURV9WQUxVRSIsInVuZGVybHlpbmdFcnJvciIsIm1hdGNoZXMiLCJ1c2VySW5mbyIsImR1cGxpY2F0ZWRfZmllbGQiLCJhdXRoRGF0YU1hdGNoIiwiY3JlYXRlT2JqZWN0cyIsIm9iamVjdHMiLCJtb25nb09iamVjdHMiLCJpbnNlcnRNYW55IiwiZGVsZXRlT2JqZWN0c0J5UXVlcnkiLCJxdWVyeSIsIm1vbmdvV2hlcmUiLCJ0cmFuc2Zvcm1XaGVyZSIsImRlbGV0ZWRDb3VudCIsIk9CSkVDVF9OT1RfRk9VTkQiLCJ1cGRhdGVPYmplY3RzQnlRdWVyeSIsInVwZGF0ZSIsIm1vbmdvVXBkYXRlIiwidHJhbnNmb3JtVXBkYXRlIiwiZmluZE9uZUFuZFVwZGF0ZSIsInJldHVybkRvY3VtZW50Iiwic2Vzc2lvbiIsInJlc3VsdCIsIm1vbmdvT2JqZWN0VG9QYXJzZU9iamVjdCIsInVwZGF0ZU9iamVjdHNCeUJ1bGsiLCJvcGVyYXRpb25zIiwiYnVsa3MiLCJ1cGRhdGVPbmUiLCJ1cHNlcnQiLCJkb2N1bWVudCIsImJ1bGtXcml0ZSIsIm9yZGVyZWQiLCJieXBhc3NEb2N1bWVudFZhbGlkYXRpb24iLCJ3cml0ZUNvbmNlcm4iLCJ3IiwiaiIsInZhbHVlIiwidXBzZXJ0T25lT2JqZWN0IiwidXBzZXJ0T25lIiwiZmluZCIsInNraXAiLCJsaW1pdCIsInNvcnQiLCJyZWFkUHJlZmVyZW5jZSIsImhpbnQiLCJjYXNlSW5zZW5zaXRpdmUiLCJjb21tZW50IiwibW9uZ29Tb3J0IiwibWFwS2V5cyIsInRyYW5zZm9ybUtleSIsIm1vbmdvS2V5cyIsIm1lbW8iLCJfcGFyc2VSZWFkUHJlZmVyZW5jZSIsImNyZWF0ZVRleHRJbmRleGVzSWZOZWVkZWQiLCJlbnN1cmVJbmRleCIsImluZGV4TmFtZSIsImluZGV4Q3JlYXRpb25SZXF1ZXN0IiwibW9uZ29GaWVsZE5hbWVzIiwiaW5kZXhUeXBlIiwiZGVmYXVsdE9wdGlvbnMiLCJiYWNrZ3JvdW5kIiwic3BhcnNlIiwiaW5kZXhOYW1lT3B0aW9ucyIsInR0bE9wdGlvbnMiLCJ0dGwiLCJleHBpcmVBZnRlclNlY29uZHMiLCJzcGFyc2VPcHRpb25zIiwiY2FzZUluc2Vuc2l0aXZlT3B0aW9ucyIsImNvbGxhdGlvbiIsImNhc2VJbnNlbnNpdGl2ZUNvbGxhdGlvbiIsInBhcnRpYWxGaWx0ZXJPcHRpb25zIiwicGFydGlhbEZpbHRlckV4cHJlc3Npb24iLCJpbmRleE9wdGlvbnMiLCJjcmVhdGVJbmRleCIsImVuc3VyZVVuaXF1ZW5lc3MiLCJfZW5zdXJlU3BhcnNlVW5pcXVlSW5kZXhJbkJhY2tncm91bmQiLCJlbnN1cmVBdXRoRGF0YVVuaXF1ZW5lc3MiLCJwcm92aWRlciIsInVuaXF1ZSIsIl9yYXdGaW5kIiwiY291bnQiLCJfZXN0aW1hdGUiLCJkaXN0aW5jdCIsImlzUG9pbnRlckZpZWxkIiwidHJhbnNmb3JtRmllbGQiLCJ0cmFuc2Zvcm1Qb2ludGVyU3RyaW5nIiwiYWdncmVnYXRlIiwicGlwZWxpbmUiLCJyYXdWYWx1ZXMiLCJyYXdGaWVsZE5hbWVzIiwiRUpTT04iLCJkZXNlcmlhbGl6ZSIsInN0YWdlIiwiJGdyb3VwIiwiX3BhcnNlQWdncmVnYXRlR3JvdXBBcmdzIiwiJG1hdGNoIiwiX3BhcnNlQWdncmVnYXRlQXJncyIsIiRwcm9qZWN0IiwiX3BhcnNlQWdncmVnYXRlUHJvamVjdEFyZ3MiLCIkZ2VvTmVhciIsInJlc3VsdHMiLCJzcGxpdCIsImlzRW1wdHkiLCJzZXJpYWxpemUiLCJpc0RhdGUiLCJyZXR1cm5WYWx1ZSIsInN1YnN0cmluZyIsIl9jb252ZXJ0VG9EYXRlIiwiaXNOYU4iLCJEYXRlIiwicGFyc2UiLCJ0b1VwcGVyQ2FzZSIsIlBSSU1BUlkiLCJQUklNQVJZX1BSRUZFUlJFRCIsIlNFQ09OREFSWSIsIlNFQ09OREFSWV9QUkVGRVJSRUQiLCJORUFSRVNUIiwicGVyZm9ybUluaXRpYWxpemF0aW9uIiwiJHRleHQiLCJ0ZXh0SW5kZXgiLCJkcm9wQWxsSW5kZXhlcyIsImRyb3BJbmRleGVzIiwidXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMiLCJjbGFzc2VzIiwicHJvbWlzZXMiLCJjcmVhdGVUcmFuc2FjdGlvbmFsU2Vzc2lvbiIsInRyYW5zYWN0aW9uYWxTZWN0aW9uIiwic3RhcnRTZXNzaW9uIiwic3RhcnRUcmFuc2FjdGlvbiIsImNvbW1pdFRyYW5zYWN0aW9uYWxTZXNzaW9uIiwiY29tbWl0IiwicmV0cmllcyIsImNvbW1pdFRyYW5zYWN0aW9uIiwiZW5kU2Vzc2lvbiIsImFib3J0VHJhbnNhY3Rpb25hbFNlc3Npb24iLCJhYm9ydFRyYW5zYWN0aW9uIiwiZXhwb3J0cyIsIl9kZWZhdWx0Il0sInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL0FkYXB0ZXJzL1N0b3JhZ2UvTW9uZ28vTW9uZ29TdG9yYWdlQWRhcHRlci5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBAZmxvd1xuaW1wb3J0IHsgZm9ybWF0IGFzIGZvcm1hdFVybCwgcGFyc2UgYXMgcGFyc2VVcmwgfSBmcm9tICcuLi8uLi8uLi92ZW5kb3IvbW9uZ29kYlVybCc7XG5pbXBvcnQgdHlwZSB7IFF1ZXJ5T3B0aW9ucywgUXVlcnlUeXBlLCBTY2hlbWFUeXBlLCBTdG9yYWdlQ2xhc3MgfSBmcm9tICcuLi9TdG9yYWdlQWRhcHRlcic7XG5pbXBvcnQgeyBTdG9yYWdlQWRhcHRlciB9IGZyb20gJy4uL1N0b3JhZ2VBZGFwdGVyJztcbmltcG9ydCBVdGlscyBmcm9tICcuLi8uLi8uLi9VdGlscyc7XG5pbXBvcnQgTW9uZ29Db2xsZWN0aW9uIGZyb20gJy4vTW9uZ29Db2xsZWN0aW9uJztcbmltcG9ydCBNb25nb1NjaGVtYUNvbGxlY3Rpb24gZnJvbSAnLi9Nb25nb1NjaGVtYUNvbGxlY3Rpb24nO1xuaW1wb3J0IHtcbiAgbW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0LFxuICBwYXJzZU9iamVjdFRvTW9uZ29PYmplY3RGb3JDcmVhdGUsXG4gIHRyYW5zZm9ybUtleSxcbiAgdHJhbnNmb3JtUG9pbnRlclN0cmluZyxcbiAgdHJhbnNmb3JtVXBkYXRlLFxuICB0cmFuc2Zvcm1XaGVyZSxcbn0gZnJvbSAnLi9Nb25nb1RyYW5zZm9ybSc7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCBQYXJzZSBmcm9tICdwYXJzZS9ub2RlJztcbi8vIEBmbG93LWRpc2FibGUtbmV4dFxuaW1wb3J0IF8gZnJvbSAnbG9kYXNoJztcbmltcG9ydCB7IEVKU09OIH0gZnJvbSAnYnNvbic7XG5pbXBvcnQgZGVmYXVsdHMsIHsgUGFyc2VTZXJ2ZXJEYXRhYmFzZU9wdGlvbnMgfSBmcm9tICcuLi8uLi8uLi9kZWZhdWx0cyc7XG5pbXBvcnQgbG9nZ2VyIGZyb20gJy4uLy4uLy4uL2xvZ2dlcic7XG5cbi8vIEBmbG93LWRpc2FibGUtbmV4dFxuY29uc3QgbW9uZ29kYiA9IHJlcXVpcmUoJ21vbmdvZGInKTtcbmNvbnN0IE1vbmdvQ2xpZW50ID0gbW9uZ29kYi5Nb25nb0NsaWVudDtcbmNvbnN0IFJlYWRQcmVmZXJlbmNlID0gbW9uZ29kYi5SZWFkUHJlZmVyZW5jZTtcblxuY29uc3QgTW9uZ29TY2hlbWFDb2xsZWN0aW9uTmFtZSA9ICdfU0NIRU1BJztcblxuLyoqXG4gKiBEZXRlcm1pbmVzIGlmIGEgTW9uZ29EQiBlcnJvciBpcyBhIHRyYW5zaWVudCBpbmZyYXN0cnVjdHVyZSBlcnJvclxuICogKGNvbm5lY3Rpb24gcG9vbCwgbmV0d29yaywgc2VydmVyIHNlbGVjdGlvbikgYXMgb3Bwb3NlZCB0byBhIHF1ZXJ5LWxldmVsIGVycm9yLlxuICovXG5mdW5jdGlvbiBpc1RyYW5zaWVudEVycm9yKGVycm9yKSB7XG4gIGlmICghZXJyb3IpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvLyBDb25uZWN0aW9uIHBvb2wsIG5ldHdvcmssIGFuZCBzZXJ2ZXIgc2VsZWN0aW9uIGVycm9yc1xuICBjb25zdCB0cmFuc2llbnRFcnJvck5hbWVzID0gW1xuICAgICdNb25nb1dhaXRRdWV1ZVRpbWVvdXRFcnJvcicsXG4gICAgJ01vbmdvU2VydmVyU2VsZWN0aW9uRXJyb3InLFxuICAgICdNb25nb05ldHdvcmtUaW1lb3V0RXJyb3InLFxuICAgICdNb25nb05ldHdvcmtFcnJvcicsXG4gIF07XG4gIGlmICh0cmFuc2llbnRFcnJvck5hbWVzLmluY2x1ZGVzKGVycm9yLm5hbWUpKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAvLyBDaGVjayBmb3IgTW9uZ29EQidzIHRyYW5zaWVudCB0cmFuc2FjdGlvbiBlcnJvciBsYWJlbFxuICBpZiAodHlwZW9mIGVycm9yLmhhc0Vycm9yTGFiZWwgPT09ICdmdW5jdGlvbicpIHtcbiAgICBpZiAoZXJyb3IuaGFzRXJyb3JMYWJlbCgnVHJhbnNpZW50VHJhbnNhY3Rpb25FcnJvcicpKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gZmFsc2U7XG59XG5cbmNvbnN0IHN0b3JhZ2VBZGFwdGVyQWxsQ29sbGVjdGlvbnMgPSBtb25nb0FkYXB0ZXIgPT4ge1xuICByZXR1cm4gbW9uZ29BZGFwdGVyXG4gICAgLmNvbm5lY3QoKVxuICAgIC50aGVuKCgpID0+IG1vbmdvQWRhcHRlci5kYXRhYmFzZS5jb2xsZWN0aW9ucygpKVxuICAgIC50aGVuKGNvbGxlY3Rpb25zID0+IHtcbiAgICAgIHJldHVybiBjb2xsZWN0aW9ucy5maWx0ZXIoY29sbGVjdGlvbiA9PiB7XG4gICAgICAgIGlmIChjb2xsZWN0aW9uLm5hbWVzcGFjZS5tYXRjaCgvXFwuc3lzdGVtXFwuLykpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgLy8gVE9ETzogSWYgeW91IGhhdmUgb25lIGFwcCB3aXRoIGEgY29sbGVjdGlvbiBwcmVmaXggdGhhdCBoYXBwZW5zIHRvIGJlIGEgcHJlZml4IG9mIGFub3RoZXJcbiAgICAgICAgLy8gYXBwcyBwcmVmaXgsIHRoaXMgd2lsbCBnbyB2ZXJ5IHZlcnkgYmFkbHkuIFdlIHNob3VsZCBmaXggdGhhdCBzb21laG93LlxuICAgICAgICByZXR1cm4gY29sbGVjdGlvbi5jb2xsZWN0aW9uTmFtZS5pbmRleE9mKG1vbmdvQWRhcHRlci5fY29sbGVjdGlvblByZWZpeCkgPT0gMDtcbiAgICAgIH0pO1xuICAgIH0pO1xufTtcblxuY29uc3QgY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYSA9ICh7IC4uLnNjaGVtYSB9KSA9PiB7XG4gIGRlbGV0ZSBzY2hlbWEuZmllbGRzLl9ycGVybTtcbiAgZGVsZXRlIHNjaGVtYS5maWVsZHMuX3dwZXJtO1xuXG4gIGlmIChzY2hlbWEuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgLy8gTGVnYWN5IG1vbmdvIGFkYXB0ZXIga25vd3MgYWJvdXQgdGhlIGRpZmZlcmVuY2UgYmV0d2VlbiBwYXNzd29yZCBhbmQgX2hhc2hlZF9wYXNzd29yZC5cbiAgICAvLyBGdXR1cmUgZGF0YWJhc2UgYWRhcHRlcnMgd2lsbCBvbmx5IGtub3cgYWJvdXQgX2hhc2hlZF9wYXNzd29yZC5cbiAgICAvLyBOb3RlOiBQYXJzZSBTZXJ2ZXIgd2lsbCBicmluZyBiYWNrIHBhc3N3b3JkIHdpdGggaW5qZWN0RGVmYXVsdFNjaGVtYSwgc28gd2UgZG9uJ3QgbmVlZFxuICAgIC8vIHRvIGFkZCBfaGFzaGVkX3Bhc3N3b3JkIGJhY2sgZXZlci5cbiAgICBkZWxldGUgc2NoZW1hLmZpZWxkcy5faGFzaGVkX3Bhc3N3b3JkO1xuICB9XG5cbiAgcmV0dXJuIHNjaGVtYTtcbn07XG5cbi8vIFJldHVybnMgeyBjb2RlLCBlcnJvciB9IGlmIGludmFsaWQsIG9yIHsgcmVzdWx0IH0sIGFuIG9iamVjdFxuLy8gc3VpdGFibGUgZm9yIGluc2VydGluZyBpbnRvIF9TQ0hFTUEgY29sbGVjdGlvbiwgb3RoZXJ3aXNlLlxuY29uc3QgbW9uZ29TY2hlbWFGcm9tRmllbGRzQW5kQ2xhc3NOYW1lQW5kQ0xQID0gKFxuICBmaWVsZHMsXG4gIGNsYXNzTmFtZSxcbiAgY2xhc3NMZXZlbFBlcm1pc3Npb25zLFxuICBpbmRleGVzXG4pID0+IHtcbiAgY29uc3QgbW9uZ29PYmplY3QgPSB7XG4gICAgX2lkOiBjbGFzc05hbWUsXG4gICAgb2JqZWN0SWQ6ICdzdHJpbmcnLFxuICAgIHVwZGF0ZWRBdDogJ3N0cmluZycsXG4gICAgY3JlYXRlZEF0OiAnc3RyaW5nJyxcbiAgICBfbWV0YWRhdGE6IHVuZGVmaW5lZCxcbiAgfTtcblxuICBmb3IgKGNvbnN0IGZpZWxkTmFtZSBpbiBmaWVsZHMpIHtcbiAgICBjb25zdCB7IHR5cGUsIHRhcmdldENsYXNzLCAuLi5maWVsZE9wdGlvbnMgfSA9IGZpZWxkc1tmaWVsZE5hbWVdO1xuICAgIG1vbmdvT2JqZWN0W2ZpZWxkTmFtZV0gPSBNb25nb1NjaGVtYUNvbGxlY3Rpb24ucGFyc2VGaWVsZFR5cGVUb01vbmdvRmllbGRUeXBlKHtcbiAgICAgIHR5cGUsXG4gICAgICB0YXJnZXRDbGFzcyxcbiAgICB9KTtcbiAgICBpZiAoZmllbGRPcHRpb25zICYmIE9iamVjdC5rZXlzKGZpZWxkT3B0aW9ucykubGVuZ3RoID4gMCkge1xuICAgICAgbW9uZ29PYmplY3QuX21ldGFkYXRhID0gbW9uZ29PYmplY3QuX21ldGFkYXRhIHx8IHt9O1xuICAgICAgbW9uZ29PYmplY3QuX21ldGFkYXRhLmZpZWxkc19vcHRpb25zID0gbW9uZ29PYmplY3QuX21ldGFkYXRhLmZpZWxkc19vcHRpb25zIHx8IHt9O1xuICAgICAgbW9uZ29PYmplY3QuX21ldGFkYXRhLmZpZWxkc19vcHRpb25zW2ZpZWxkTmFtZV0gPSBmaWVsZE9wdGlvbnM7XG4gICAgfVxuICB9XG5cbiAgaWYgKHR5cGVvZiBjbGFzc0xldmVsUGVybWlzc2lvbnMgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgbW9uZ29PYmplY3QuX21ldGFkYXRhID0gbW9uZ29PYmplY3QuX21ldGFkYXRhIHx8IHt9O1xuICAgIGlmICghY2xhc3NMZXZlbFBlcm1pc3Npb25zKSB7XG4gICAgICBkZWxldGUgbW9uZ29PYmplY3QuX21ldGFkYXRhLmNsYXNzX3Blcm1pc3Npb25zO1xuICAgIH0gZWxzZSB7XG4gICAgICBtb25nb09iamVjdC5fbWV0YWRhdGEuY2xhc3NfcGVybWlzc2lvbnMgPSBjbGFzc0xldmVsUGVybWlzc2lvbnM7XG4gICAgfVxuICB9XG5cbiAgaWYgKGluZGV4ZXMgJiYgdHlwZW9mIGluZGV4ZXMgPT09ICdvYmplY3QnICYmIE9iamVjdC5rZXlzKGluZGV4ZXMpLmxlbmd0aCA+IDApIHtcbiAgICBtb25nb09iamVjdC5fbWV0YWRhdGEgPSBtb25nb09iamVjdC5fbWV0YWRhdGEgfHwge307XG4gICAgbW9uZ29PYmplY3QuX21ldGFkYXRhLmluZGV4ZXMgPSBpbmRleGVzO1xuICB9XG5cbiAgaWYgKCFtb25nb09iamVjdC5fbWV0YWRhdGEpIHtcbiAgICAvLyBjbGVhbnVwIHRoZSB1bnVzZWQgX21ldGFkYXRhXG4gICAgZGVsZXRlIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YTtcbiAgfVxuXG4gIHJldHVybiBtb25nb09iamVjdDtcbn07XG5cbmZ1bmN0aW9uIHZhbGlkYXRlRXhwbGFpblZhbHVlKGV4cGxhaW4pIHtcbiAgaWYgKGV4cGxhaW4pIHtcbiAgICAvLyBUaGUgbGlzdCBvZiBhbGxvd2VkIGV4cGxhaW4gdmFsdWVzIGlzIGZyb20gbm9kZS1tb25nb2RiLW5hdGl2ZS9saWIvZXhwbGFpbi5qc1xuICAgIGNvbnN0IGV4cGxhaW5BbGxvd2VkVmFsdWVzID0gW1xuICAgICAgJ3F1ZXJ5UGxhbm5lcicsXG4gICAgICAncXVlcnlQbGFubmVyRXh0ZW5kZWQnLFxuICAgICAgJ2V4ZWN1dGlvblN0YXRzJyxcbiAgICAgICdhbGxQbGFuc0V4ZWN1dGlvbicsXG4gICAgICBmYWxzZSxcbiAgICAgIHRydWUsXG4gICAgXTtcbiAgICBpZiAoIWV4cGxhaW5BbGxvd2VkVmFsdWVzLmluY2x1ZGVzKGV4cGxhaW4pKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJ0ludmFsaWQgdmFsdWUgZm9yIGV4cGxhaW4nKTtcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIE1vbmdvU3RvcmFnZUFkYXB0ZXIgaW1wbGVtZW50cyBTdG9yYWdlQWRhcHRlciB7XG4gIC8vIFByaXZhdGVcbiAgX3VyaTogc3RyaW5nO1xuICBfY29sbGVjdGlvblByZWZpeDogc3RyaW5nO1xuICBfbW9uZ29PcHRpb25zOiBPYmplY3Q7XG4gIF9vbmNoYW5nZTogYW55O1xuICBfc3RyZWFtOiBhbnk7XG4gIF9sb2dDbGllbnRFdmVudHM6ID9BcnJheTxhbnk+O1xuICBfY2xpZW50TWV0YWRhdGE6ID97IG5hbWU6IHN0cmluZywgdmVyc2lvbjogc3RyaW5nIH07XG4gIC8vIFB1YmxpY1xuICBjb25uZWN0aW9uUHJvbWlzZTogP1Byb21pc2U8YW55PjtcbiAgZGF0YWJhc2U6IGFueTtcbiAgY2xpZW50OiBNb25nb0NsaWVudDtcbiAgX21heFRpbWVNUzogP251bWJlcjtcbiAgX2JhdGNoU2l6ZTogP251bWJlcjtcbiAgY2FuU29ydE9uSm9pblRhYmxlczogYm9vbGVhbjtcbiAgZW5hYmxlU2NoZW1hSG9va3M6IGJvb2xlYW47XG4gIHNjaGVtYUNhY2hlVHRsOiA/bnVtYmVyO1xuICBkaXNhYmxlSW5kZXhGaWVsZFZhbGlkYXRpb246IGJvb2xlYW47XG5cbiAgY29uc3RydWN0b3IoeyB1cmkgPSBkZWZhdWx0cy5EZWZhdWx0TW9uZ29VUkksIGNvbGxlY3Rpb25QcmVmaXggPSAnJywgbW9uZ29PcHRpb25zID0ge30gfTogYW55KSB7XG4gICAgdGhpcy5fdXJpID0gdXJpO1xuICAgIHRoaXMuX2NvbGxlY3Rpb25QcmVmaXggPSBjb2xsZWN0aW9uUHJlZml4O1xuICAgIHRoaXMuX29uY2hhbmdlID0gKCkgPT4ge307XG5cbiAgICAvLyBNYXhUaW1lTVMgaXMgbm90IGEgZ2xvYmFsIE1vbmdvREIgY2xpZW50IG9wdGlvbiwgaXQgaXMgYXBwbGllZCBwZXIgb3BlcmF0aW9uLlxuICAgIHRoaXMuX21heFRpbWVNUyA9IG1vbmdvT3B0aW9ucy5tYXhUaW1lTVM7XG4gICAgLy8gQmF0Y2hTaXplIGlzIG5vdCBhIGdsb2JhbCBNb25nb0RCIGNsaWVudCBvcHRpb24sIGl0IGlzIGFwcGxpZWQgcGVyIGN1cnNvciBvcGVyYXRpb24uXG4gICAgdGhpcy5fYmF0Y2hTaXplID0gbW9uZ29PcHRpb25zLmJhdGNoU2l6ZTtcbiAgICB0aGlzLmNhblNvcnRPbkpvaW5UYWJsZXMgPSB0cnVlO1xuICAgIHRoaXMuZW5hYmxlU2NoZW1hSG9va3MgPSAhIW1vbmdvT3B0aW9ucy5lbmFibGVTY2hlbWFIb29rcztcbiAgICB0aGlzLnNjaGVtYUNhY2hlVHRsID0gbW9uZ29PcHRpb25zLnNjaGVtYUNhY2hlVHRsO1xuICAgIHRoaXMuZGlzYWJsZUluZGV4RmllbGRWYWxpZGF0aW9uID0gISFtb25nb09wdGlvbnMuZGlzYWJsZUluZGV4RmllbGRWYWxpZGF0aW9uO1xuICAgIHRoaXMuX2xvZ0NsaWVudEV2ZW50cyA9IG1vbmdvT3B0aW9ucy5sb2dDbGllbnRFdmVudHM7XG4gICAgdGhpcy5fY2xpZW50TWV0YWRhdGEgPSBtb25nb09wdGlvbnMuY2xpZW50TWV0YWRhdGE7XG5cbiAgICAvLyBDcmVhdGUgYSBjb3B5IG9mIG1vbmdvT3B0aW9ucyBhbmQgcmVtb3ZlIFBhcnNlIFNlcnZlci1zcGVjaWZpYyBvcHRpb25zIHRoYXQgc2hvdWxkIG5vdFxuICAgIC8vIGJlIHBhc3NlZCB0byBNb25nb0RCIGNsaWVudC4gTm90ZTogV2Ugb25seSBkZWxldGUgZnJvbSB0aGlzLl9tb25nb09wdGlvbnMsIG5vdCBmcm9tIHRoZVxuICAgIC8vIG9yaWdpbmFsIG1vbmdvT3B0aW9ucyBvYmplY3QsIGJlY2F1c2Ugb3RoZXIgY29tcG9uZW50cyAobGlrZSBEYXRhYmFzZUNvbnRyb2xsZXIpIG5lZWRcbiAgICAvLyBhY2Nlc3MgdG8gdGhlc2Ugb3B0aW9ucy5cbiAgICB0aGlzLl9tb25nb09wdGlvbnMgPSB7IC4uLm1vbmdvT3B0aW9ucyB9O1xuICAgIGZvciAoY29uc3Qga2V5IG9mIFBhcnNlU2VydmVyRGF0YWJhc2VPcHRpb25zKSB7XG4gICAgICBkZWxldGUgdGhpcy5fbW9uZ29PcHRpb25zW2tleV07XG4gICAgfVxuICB9XG5cbiAgd2F0Y2goY2FsbGJhY2s6ICgpID0+IHZvaWQpOiB2b2lkIHtcbiAgICB0aGlzLl9vbmNoYW5nZSA9IGNhbGxiYWNrO1xuICB9XG5cbiAgY29ubmVjdCgpIHtcbiAgICBpZiAodGhpcy5jb25uZWN0aW9uUHJvbWlzZSkge1xuICAgICAgcmV0dXJuIHRoaXMuY29ubmVjdGlvblByb21pc2U7XG4gICAgfVxuXG4gICAgLy8gcGFyc2luZyBhbmQgcmUtZm9ybWF0dGluZyBjYXVzZXMgdGhlIGF1dGggdmFsdWUgKGlmIHRoZXJlKSB0byBnZXQgVVJJXG4gICAgLy8gZW5jb2RlZFxuICAgIGNvbnN0IGVuY29kZWRVcmkgPSBmb3JtYXRVcmwocGFyc2VVcmwodGhpcy5fdXJpKSk7XG5cbiAgICAvLyBPbmx5IHVzZSBkcml2ZXJJbmZvIGlmIGNsaWVudE1ldGFkYXRhIG9wdGlvbiBpcyBzZXRcbiAgICBjb25zdCBvcHRpb25zID0geyAuLi50aGlzLl9tb25nb09wdGlvbnMgfTtcbiAgICBpZiAodGhpcy5fY2xpZW50TWV0YWRhdGEpIHtcbiAgICAgIG9wdGlvbnMuZHJpdmVySW5mbyA9IHtcbiAgICAgICAgbmFtZTogdGhpcy5fY2xpZW50TWV0YWRhdGEubmFtZSxcbiAgICAgICAgdmVyc2lvbjogdGhpcy5fY2xpZW50TWV0YWRhdGEudmVyc2lvblxuICAgICAgfTtcbiAgICB9XG5cbiAgICB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlID0gTW9uZ29DbGllbnQuY29ubmVjdChlbmNvZGVkVXJpLCBvcHRpb25zKVxuICAgICAgLnRoZW4oY2xpZW50ID0+IHtcbiAgICAgICAgLy8gU3RhcnRpbmcgbW9uZ29EQiAzLjAsIHRoZSBNb25nb0NsaWVudC5jb25uZWN0IGRvbid0IHJldHVybiBhIERCIGFueW1vcmUgYnV0IGEgY2xpZW50XG4gICAgICAgIC8vIEZvcnR1bmF0ZWx5LCB3ZSBjYW4gZ2V0IGJhY2sgdGhlIG9wdGlvbnMgYW5kIHVzZSB0aGVtIHRvIHNlbGVjdCB0aGUgcHJvcGVyIERCLlxuICAgICAgICAvLyBodHRwczovL2dpdGh1Yi5jb20vbW9uZ29kYi9ub2RlLW1vbmdvZGItbmF0aXZlL2Jsb2IvMmMzNWQ3NmYwODU3NDIyNWI4ZGIwMmQ3YmVmNjg3MTIzZTZiYjAxOC9saWIvbW9uZ29fY2xpZW50LmpzI0w4ODVcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNsaWVudC5zLm9wdGlvbnM7XG4gICAgICAgIGNvbnN0IGRhdGFiYXNlID0gY2xpZW50LmRiKG9wdGlvbnMuZGJOYW1lKTtcbiAgICAgICAgaWYgKCFkYXRhYmFzZSkge1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjbGllbnQub24oJ2Vycm9yJywgKCkgPT4ge1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgICAgICB9KTtcbiAgICAgICAgY2xpZW50Lm9uKCdjbG9zZScsICgpID0+IHtcbiAgICAgICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gU2V0IHVwIGNsaWVudCBldmVudCBsb2dnaW5nIGlmIGNvbmZpZ3VyZWRcbiAgICAgICAgaWYgKHRoaXMuX2xvZ0NsaWVudEV2ZW50cyAmJiBBcnJheS5pc0FycmF5KHRoaXMuX2xvZ0NsaWVudEV2ZW50cykpIHtcbiAgICAgICAgICB0aGlzLl9sb2dDbGllbnRFdmVudHMuZm9yRWFjaChldmVudENvbmZpZyA9PiB7XG4gICAgICAgICAgICBjbGllbnQub24oZXZlbnRDb25maWcubmFtZSwgZXZlbnQgPT4ge1xuICAgICAgICAgICAgICBsZXQgbG9nRGF0YSA9IHt9O1xuICAgICAgICAgICAgICBpZiAoIWV2ZW50Q29uZmlnLmtleXMgfHwgZXZlbnRDb25maWcua2V5cy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICBsb2dEYXRhID0gZXZlbnQ7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZXZlbnRDb25maWcua2V5cy5mb3JFYWNoKGtleVBhdGggPT4ge1xuICAgICAgICAgICAgICAgICAgbG9nRGF0YVtrZXlQYXRoXSA9IF8uZ2V0KGV2ZW50LCBrZXlQYXRoKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIC8vIFZhbGlkYXRlIGxvZyBsZXZlbCBleGlzdHMsIGZhbGxiYWNrIHRvICdpbmZvJ1xuICAgICAgICAgICAgICBjb25zdCBsb2dMZXZlbCA9IHR5cGVvZiBsb2dnZXJbZXZlbnRDb25maWcubG9nTGV2ZWxdID09PSAnZnVuY3Rpb24nID8gZXZlbnRDb25maWcubG9nTGV2ZWwgOiAnaW5mbyc7XG5cbiAgICAgICAgICAgICAgLy8gU2FmZSBKU09OIHNlcmlhbGl6YXRpb24gd2l0aCBNYXAvU2V0IGFuZCBjaXJjdWxhciByZWZlcmVuY2Ugc3VwcG9ydFxuICAgICAgICAgICAgICBjb25zdCBsb2dNZXNzYWdlID0gYE1vbmdvREIgY2xpZW50IGV2ZW50ICR7ZXZlbnRDb25maWcubmFtZX06ICR7SlNPTi5zdHJpbmdpZnkobG9nRGF0YSwgVXRpbHMuZ2V0Q2lyY3VsYXJSZXBsYWNlcigpKX1gO1xuXG4gICAgICAgICAgICAgIGxvZ2dlcltsb2dMZXZlbF0obG9nTWVzc2FnZSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuY2xpZW50ID0gY2xpZW50O1xuICAgICAgICB0aGlzLmRhdGFiYXNlID0gZGF0YWJhc2U7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoZXJyKTtcbiAgICAgIH0pO1xuXG4gICAgcmV0dXJuIHRoaXMuY29ubmVjdGlvblByb21pc2U7XG4gIH1cblxuICBoYW5kbGVFcnJvcjxUPihlcnJvcjogPyhFcnJvciB8IFBhcnNlLkVycm9yKSk6IFByb21pc2U8VD4ge1xuICAgIGlmIChlcnJvciAmJiBlcnJvci5jb2RlID09PSAxMykge1xuICAgICAgLy8gVW5hdXRob3JpemVkIGVycm9yXG4gICAgICBkZWxldGUgdGhpcy5jbGllbnQ7XG4gICAgICBkZWxldGUgdGhpcy5kYXRhYmFzZTtcbiAgICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgICAgbG9nZ2VyLmVycm9yKCdSZWNlaXZlZCB1bmF1dGhvcml6ZWQgZXJyb3InLCB7IGVycm9yOiBlcnJvciB9KTtcbiAgICB9XG5cbiAgICAvLyBUcmFuc2Zvcm0gaW5mcmFzdHJ1Y3R1cmUvdHJhbnNpZW50IGVycm9ycyBpbnRvIFBhcnNlLkVycm9yLklOVEVSTkFMX1NFUlZFUl9FUlJPUlxuICAgIGlmIChpc1RyYW5zaWVudEVycm9yKGVycm9yKSkge1xuICAgICAgbG9nZ2VyLmVycm9yKCdEYXRhYmFzZSB0cmFuc2llbnQgZXJyb3InLCBlcnJvcik7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLCAnRGF0YWJhc2UgZXJyb3InKTtcbiAgICB9XG5cbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuXG4gIGFzeW5jIGhhbmRsZVNodXRkb3duKCkge1xuICAgIGlmICghdGhpcy5jbGllbnQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgYXdhaXQgdGhpcy5jbGllbnQuY2xvc2UoZmFsc2UpO1xuICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICB9XG5cbiAgX2FkYXB0aXZlQ29sbGVjdGlvbihuYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5jb25uZWN0KClcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuZGF0YWJhc2UuY29sbGVjdGlvbih0aGlzLl9jb2xsZWN0aW9uUHJlZml4ICsgbmFtZSkpXG4gICAgICAudGhlbihyYXdDb2xsZWN0aW9uID0+IG5ldyBNb25nb0NvbGxlY3Rpb24ocmF3Q29sbGVjdGlvbikpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBfc2NoZW1hQ29sbGVjdGlvbigpOiBQcm9taXNlPE1vbmdvU2NoZW1hQ29sbGVjdGlvbj4ge1xuICAgIHJldHVybiB0aGlzLmNvbm5lY3QoKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKE1vbmdvU2NoZW1hQ29sbGVjdGlvbk5hbWUpKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiB7XG4gICAgICAgIGlmICghdGhpcy5fc3RyZWFtICYmIHRoaXMuZW5hYmxlU2NoZW1hSG9va3MpIHtcbiAgICAgICAgICB0aGlzLl9zdHJlYW0gPSBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24ud2F0Y2goKTtcbiAgICAgICAgICB0aGlzLl9zdHJlYW0ub24oJ2NoYW5nZScsICgpID0+IHRoaXMuX29uY2hhbmdlKCkpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBuZXcgTW9uZ29TY2hlbWFDb2xsZWN0aW9uKGNvbGxlY3Rpb24pO1xuICAgICAgfSk7XG4gIH1cblxuICBjbGFzc0V4aXN0cyhuYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5jb25uZWN0KClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGF0YWJhc2UubGlzdENvbGxlY3Rpb25zKHsgbmFtZTogdGhpcy5fY29sbGVjdGlvblByZWZpeCArIG5hbWUgfSkudG9BcnJheSgpO1xuICAgICAgfSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb25zID0+IHtcbiAgICAgICAgcmV0dXJuIGNvbGxlY3Rpb25zLmxlbmd0aCA+IDA7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgc2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zKGNsYXNzTmFtZTogc3RyaW5nLCBDTFBzOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpXG4gICAgICAudGhlbihzY2hlbWFDb2xsZWN0aW9uID0+XG4gICAgICAgIHNjaGVtYUNvbGxlY3Rpb24udXBkYXRlU2NoZW1hKGNsYXNzTmFtZSwge1xuICAgICAgICAgICRzZXQ6IHsgJ19tZXRhZGF0YS5jbGFzc19wZXJtaXNzaW9ucyc6IENMUHMgfSxcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIHNldEluZGV4ZXNXaXRoU2NoZW1hRm9ybWF0KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHN1Ym1pdHRlZEluZGV4ZXM6IGFueSxcbiAgICBleGlzdGluZ0luZGV4ZXM6IGFueSA9IHt9LFxuICAgIGZpZWxkczogYW55XG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChzdWJtaXR0ZWRJbmRleGVzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICB9XG4gICAgaWYgKE9iamVjdC5rZXlzKGV4aXN0aW5nSW5kZXhlcykubGVuZ3RoID09PSAwKSB7XG4gICAgICBleGlzdGluZ0luZGV4ZXMgPSB7IF9pZF86IHsgX2lkOiAxIH0gfTtcbiAgICB9XG4gICAgY29uc3QgZGVsZXRlUHJvbWlzZXMgPSBbXTtcbiAgICBjb25zdCBpbnNlcnRlZEluZGV4ZXMgPSBbXTtcbiAgICBPYmplY3Qua2V5cyhzdWJtaXR0ZWRJbmRleGVzKS5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgY29uc3QgZmllbGQgPSBzdWJtaXR0ZWRJbmRleGVzW25hbWVdO1xuICAgICAgaWYgKGV4aXN0aW5nSW5kZXhlc1tuYW1lXSAmJiBmaWVsZC5fX29wICE9PSAnRGVsZXRlJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgYEluZGV4ICR7bmFtZX0gZXhpc3RzLCBjYW5ub3QgdXBkYXRlLmApO1xuICAgICAgfVxuICAgICAgaWYgKCFleGlzdGluZ0luZGV4ZXNbbmFtZV0gJiYgZmllbGQuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICAgYEluZGV4ICR7bmFtZX0gZG9lcyBub3QgZXhpc3QsIGNhbm5vdCBkZWxldGUuYFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKGZpZWxkLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLmRyb3BJbmRleChjbGFzc05hbWUsIG5hbWUpO1xuICAgICAgICBkZWxldGVQcm9taXNlcy5wdXNoKHByb21pc2UpO1xuICAgICAgICBkZWxldGUgZXhpc3RpbmdJbmRleGVzW25hbWVdO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgT2JqZWN0LmtleXMoZmllbGQpLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAhdGhpcy5kaXNhYmxlSW5kZXhGaWVsZFZhbGlkYXRpb24gJiZcbiAgICAgICAgICAgICFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoXG4gICAgICAgICAgICAgIGZpZWxkcyxcbiAgICAgICAgICAgICAga2V5LmluZGV4T2YoJ19wXycpID09PSAwID8ga2V5LnJlcGxhY2UoJ19wXycsICcnKSA6IGtleVxuICAgICAgICAgICAgKVxuICAgICAgICAgICkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgICAgICBgRmllbGQgJHtrZXl9IGRvZXMgbm90IGV4aXN0LCBjYW5ub3QgYWRkIGluZGV4LmBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgZXhpc3RpbmdJbmRleGVzW25hbWVdID0gZmllbGQ7XG4gICAgICAgIGluc2VydGVkSW5kZXhlcy5wdXNoKHtcbiAgICAgICAgICBrZXk6IGZpZWxkLFxuICAgICAgICAgIG5hbWUsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGxldCBpbnNlcnRQcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgaWYgKGluc2VydGVkSW5kZXhlcy5sZW5ndGggPiAwKSB7XG4gICAgICBpbnNlcnRQcm9taXNlID0gdGhpcy5jcmVhdGVJbmRleGVzKGNsYXNzTmFtZSwgaW5zZXJ0ZWRJbmRleGVzKTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UuYWxsKGRlbGV0ZVByb21pc2VzKVxuICAgICAgLnRoZW4oKCkgPT4gaW5zZXJ0UHJvbWlzZSlcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKSlcbiAgICAgIC50aGVuKHNjaGVtYUNvbGxlY3Rpb24gPT5cbiAgICAgICAgc2NoZW1hQ29sbGVjdGlvbi51cGRhdGVTY2hlbWEoY2xhc3NOYW1lLCB7XG4gICAgICAgICAgJHNldDogeyAnX21ldGFkYXRhLmluZGV4ZXMnOiBleGlzdGluZ0luZGV4ZXMgfSxcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIHNldEluZGV4ZXNGcm9tTW9uZ28oY2xhc3NOYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5nZXRJbmRleGVzKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGluZGV4ZXMgPT4ge1xuICAgICAgICBpbmRleGVzID0gaW5kZXhlcy5yZWR1Y2UoKG9iaiwgaW5kZXgpID0+IHtcbiAgICAgICAgICBpZiAoaW5kZXgua2V5Ll9mdHMpIHtcbiAgICAgICAgICAgIGRlbGV0ZSBpbmRleC5rZXkuX2Z0cztcbiAgICAgICAgICAgIGRlbGV0ZSBpbmRleC5rZXkuX2Z0c3g7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIGluZGV4LndlaWdodHMpIHtcbiAgICAgICAgICAgICAgaW5kZXgua2V5W2ZpZWxkXSA9ICd0ZXh0JztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgb2JqW2luZGV4Lm5hbWVdID0gaW5kZXgua2V5O1xuICAgICAgICAgIHJldHVybiBvYmo7XG4gICAgICAgIH0sIHt9KTtcbiAgICAgICAgcmV0dXJuIHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKS50aGVuKHNjaGVtYUNvbGxlY3Rpb24gPT5cbiAgICAgICAgICBzY2hlbWFDb2xsZWN0aW9uLnVwZGF0ZVNjaGVtYShjbGFzc05hbWUsIHtcbiAgICAgICAgICAgICRzZXQ6IHsgJ19tZXRhZGF0YS5pbmRleGVzJzogaW5kZXhlcyB9LFxuICAgICAgICAgIH0pXG4gICAgICAgICk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpXG4gICAgICAuY2F0Y2goKCkgPT4ge1xuICAgICAgICAvLyBJZ25vcmUgaWYgY29sbGVjdGlvbiBub3QgZm91bmRcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgfSk7XG4gIH1cblxuICBjcmVhdGVDbGFzcyhjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvT2JqZWN0ID0gbW9uZ29TY2hlbWFGcm9tRmllbGRzQW5kQ2xhc3NOYW1lQW5kQ0xQKFxuICAgICAgc2NoZW1hLmZpZWxkcyxcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHNjaGVtYS5jbGFzc0xldmVsUGVybWlzc2lvbnMsXG4gICAgICBzY2hlbWEuaW5kZXhlc1xuICAgICk7XG4gICAgbW9uZ29PYmplY3QuX2lkID0gY2xhc3NOYW1lO1xuICAgIHJldHVybiB0aGlzLnNldEluZGV4ZXNXaXRoU2NoZW1hRm9ybWF0KGNsYXNzTmFtZSwgc2NoZW1hLmluZGV4ZXMsIHt9LCBzY2hlbWEuZmllbGRzKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpKVxuICAgICAgLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PiBzY2hlbWFDb2xsZWN0aW9uLmluc2VydFNjaGVtYShtb25nb09iamVjdCkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBhc3luYyB1cGRhdGVGaWVsZE9wdGlvbnMoY2xhc3NOYW1lOiBzdHJpbmcsIGZpZWxkTmFtZTogc3RyaW5nLCB0eXBlOiBhbnkpIHtcbiAgICBjb25zdCBzY2hlbWFDb2xsZWN0aW9uID0gYXdhaXQgdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpO1xuICAgIGF3YWl0IHNjaGVtYUNvbGxlY3Rpb24udXBkYXRlRmllbGRPcHRpb25zKGNsYXNzTmFtZSwgZmllbGROYW1lLCB0eXBlKTtcbiAgfVxuXG4gIGFkZEZpZWxkSWZOb3RFeGlzdHMoY2xhc3NOYW1lOiBzdHJpbmcsIGZpZWxkTmFtZTogc3RyaW5nLCB0eXBlOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpXG4gICAgICAudGhlbihzY2hlbWFDb2xsZWN0aW9uID0+IHNjaGVtYUNvbGxlY3Rpb24uYWRkRmllbGRJZk5vdEV4aXN0cyhjbGFzc05hbWUsIGZpZWxkTmFtZSwgdHlwZSkpXG4gICAgICAudGhlbigoKSA9PiB0aGlzLmNyZWF0ZUluZGV4ZXNJZk5lZWRlZChjbGFzc05hbWUsIGZpZWxkTmFtZSwgdHlwZSkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBEcm9wcyBhIGNvbGxlY3Rpb24uIFJlc29sdmVzIHdpdGggdHJ1ZSBpZiBpdCB3YXMgYSBQYXJzZSBTY2hlbWEgKGVnLiBfVXNlciwgQ3VzdG9tLCBldGMuKVxuICAvLyBhbmQgcmVzb2x2ZXMgd2l0aCBmYWxzZSBpZiBpdCB3YXNuJ3QgKGVnLiBhIGpvaW4gdGFibGUpLiBSZWplY3RzIGlmIGRlbGV0aW9uIHdhcyBpbXBvc3NpYmxlLlxuICBkZWxldGVDbGFzcyhjbGFzc05hbWU6IHN0cmluZykge1xuICAgIHJldHVybiAoXG4gICAgICB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uZHJvcCgpKVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgIC8vICducyBub3QgZm91bmQnIG1lYW5zIGNvbGxlY3Rpb24gd2FzIGFscmVhZHkgZ29uZS4gSWdub3JlIGRlbGV0aW9uIGF0dGVtcHQuXG4gICAgICAgICAgaWYgKGVycm9yLm1lc3NhZ2UgPT0gJ25zIG5vdCBmb3VuZCcpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH0pXG4gICAgICAgIC8vIFdlJ3ZlIGRyb3BwZWQgdGhlIGNvbGxlY3Rpb24sIG5vdyByZW1vdmUgdGhlIF9TQ0hFTUEgZG9jdW1lbnRcbiAgICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpKVxuICAgICAgICAudGhlbihzY2hlbWFDb2xsZWN0aW9uID0+IHNjaGVtYUNvbGxlY3Rpb24uZmluZEFuZERlbGV0ZVNjaGVtYShjbGFzc05hbWUpKVxuICAgICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSlcbiAgICApO1xuICB9XG5cbiAgZGVsZXRlQWxsQ2xhc3NlcyhmYXN0OiBib29sZWFuKSB7XG4gICAgcmV0dXJuIHN0b3JhZ2VBZGFwdGVyQWxsQ29sbGVjdGlvbnModGhpcykudGhlbihjb2xsZWN0aW9ucyA9PlxuICAgICAgUHJvbWlzZS5hbGwoXG4gICAgICAgIGNvbGxlY3Rpb25zLm1hcChjb2xsZWN0aW9uID0+IChmYXN0ID8gY29sbGVjdGlvbi5kZWxldGVNYW55KHt9KSA6IGNvbGxlY3Rpb24uZHJvcCgpKSlcbiAgICAgIClcbiAgICApO1xuICB9XG5cbiAgLy8gUmVtb3ZlIHRoZSBjb2x1bW4gYW5kIGFsbCB0aGUgZGF0YS4gRm9yIFJlbGF0aW9ucywgdGhlIF9Kb2luIGNvbGxlY3Rpb24gaXMgaGFuZGxlZFxuICAvLyBzcGVjaWFsbHksIHRoaXMgZnVuY3Rpb24gZG9lcyBub3QgZGVsZXRlIF9Kb2luIGNvbHVtbnMuIEl0IHNob3VsZCwgaG93ZXZlciwgaW5kaWNhdGVcbiAgLy8gdGhhdCB0aGUgcmVsYXRpb24gZmllbGRzIGRvZXMgbm90IGV4aXN0IGFueW1vcmUuIEluIG1vbmdvLCB0aGlzIG1lYW5zIHJlbW92aW5nIGl0IGZyb21cbiAgLy8gdGhlIF9TQ0hFTUEgY29sbGVjdGlvbi4gIFRoZXJlIHNob3VsZCBiZSBubyBhY3R1YWwgZGF0YSBpbiB0aGUgY29sbGVjdGlvbiB1bmRlciB0aGUgc2FtZSBuYW1lXG4gIC8vIGFzIHRoZSByZWxhdGlvbiBjb2x1bW4sIHNvIGl0J3MgZmluZSB0byBhdHRlbXB0IHRvIGRlbGV0ZSBpdC4gSWYgdGhlIGZpZWxkcyBsaXN0ZWQgdG8gYmVcbiAgLy8gZGVsZXRlZCBkbyBub3QgZXhpc3QsIHRoaXMgZnVuY3Rpb24gc2hvdWxkIHJldHVybiBzdWNjZXNzZnVsbHkgYW55d2F5cy4gQ2hlY2tpbmcgZm9yXG4gIC8vIGF0dGVtcHRzIHRvIGRlbGV0ZSBub24tZXhpc3RlbnQgZmllbGRzIGlzIHRoZSByZXNwb25zaWJpbGl0eSBvZiBQYXJzZSBTZXJ2ZXIuXG5cbiAgLy8gUG9pbnRlciBmaWVsZCBuYW1lcyBhcmUgcGFzc2VkIGZvciBsZWdhY3kgcmVhc29uczogdGhlIG9yaWdpbmFsIG1vbmdvXG4gIC8vIGZvcm1hdCBzdG9yZWQgcG9pbnRlciBmaWVsZCBuYW1lcyBkaWZmZXJlbnRseSBpbiB0aGUgZGF0YWJhc2UsIGFuZCB0aGVyZWZvcmVcbiAgLy8gbmVlZGVkIHRvIGtub3cgdGhlIHR5cGUgb2YgdGhlIGZpZWxkIGJlZm9yZSBpdCBjb3VsZCBkZWxldGUgaXQuIEZ1dHVyZSBkYXRhYmFzZVxuICAvLyBhZGFwdGVycyBzaG91bGQgaWdub3JlIHRoZSBwb2ludGVyRmllbGROYW1lcyBhcmd1bWVudC4gQWxsIHRoZSBmaWVsZCBuYW1lcyBhcmUgaW5cbiAgLy8gZmllbGROYW1lcywgdGhleSBzaG93IHVwIGFkZGl0aW9uYWxseSBpbiB0aGUgcG9pbnRlckZpZWxkTmFtZXMgZGF0YWJhc2UgZm9yIHVzZVxuICAvLyBieSB0aGUgbW9uZ28gYWRhcHRlciwgd2hpY2ggZGVhbHMgd2l0aCB0aGUgbGVnYWN5IG1vbmdvIGZvcm1hdC5cblxuICAvLyBUaGlzIGZ1bmN0aW9uIGlzIG5vdCBvYmxpZ2F0ZWQgdG8gZGVsZXRlIGZpZWxkcyBhdG9taWNhbGx5LiBJdCBpcyBnaXZlbiB0aGUgZmllbGRcbiAgLy8gbmFtZXMgaW4gYSBsaXN0IHNvIHRoYXQgZGF0YWJhc2VzIHRoYXQgYXJlIGNhcGFibGUgb2YgZGVsZXRpbmcgZmllbGRzIGF0b21pY2FsbHlcbiAgLy8gbWF5IGRvIHNvLlxuXG4gIC8vIFJldHVybnMgYSBQcm9taXNlLlxuICBkZWxldGVGaWVsZHMoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgZmllbGROYW1lczogc3RyaW5nW10pIHtcbiAgICBjb25zdCBtb25nb0Zvcm1hdE5hbWVzID0gZmllbGROYW1lcy5tYXAoZmllbGROYW1lID0+IHtcbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1BvaW50ZXInKSB7XG4gICAgICAgIHJldHVybiBgX3BfJHtmaWVsZE5hbWV9YDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiBmaWVsZE5hbWU7XG4gICAgICB9XG4gICAgfSk7XG4gICAgY29uc3QgY29sbGVjdGlvblVwZGF0ZSA9IHsgJHVuc2V0OiB7fSB9O1xuICAgIG1vbmdvRm9ybWF0TmFtZXMuZm9yRWFjaChuYW1lID0+IHtcbiAgICAgIGNvbGxlY3Rpb25VcGRhdGVbJyR1bnNldCddW25hbWVdID0gbnVsbDtcbiAgICB9KTtcblxuICAgIGNvbnN0IGNvbGxlY3Rpb25GaWx0ZXIgPSB7ICRvcjogW10gfTtcbiAgICBtb25nb0Zvcm1hdE5hbWVzLmZvckVhY2gobmFtZSA9PiB7XG4gICAgICBjb2xsZWN0aW9uRmlsdGVyWyckb3InXS5wdXNoKHsgW25hbWVdOiB7ICRleGlzdHM6IHRydWUgfSB9KTtcbiAgICB9KTtcblxuICAgIGNvbnN0IHNjaGVtYVVwZGF0ZSA9IHsgJHVuc2V0OiB7fSB9O1xuICAgIGZpZWxkTmFtZXMuZm9yRWFjaChuYW1lID0+IHtcbiAgICAgIHNjaGVtYVVwZGF0ZVsnJHVuc2V0J11bbmFtZV0gPSBudWxsO1xuICAgICAgc2NoZW1hVXBkYXRlWyckdW5zZXQnXVtgX21ldGFkYXRhLmZpZWxkc19vcHRpb25zLiR7bmFtZX1gXSA9IG51bGw7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi51cGRhdGVNYW55KGNvbGxlY3Rpb25GaWx0ZXIsIGNvbGxlY3Rpb25VcGRhdGUpKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpKVxuICAgICAgLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PiBzY2hlbWFDb2xsZWN0aW9uLnVwZGF0ZVNjaGVtYShjbGFzc05hbWUsIHNjaGVtYVVwZGF0ZSkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBSZXR1cm4gYSBwcm9taXNlIGZvciBhbGwgc2NoZW1hcyBrbm93biB0byB0aGlzIGFkYXB0ZXIsIGluIFBhcnNlIGZvcm1hdC4gSW4gY2FzZSB0aGVcbiAgLy8gc2NoZW1hcyBjYW5ub3QgYmUgcmV0cmlldmVkLCByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlamVjdHMuIFJlcXVpcmVtZW50cyBmb3IgdGhlXG4gIC8vIHJlamVjdGlvbiByZWFzb24gYXJlIFRCRC5cbiAgZ2V0QWxsQ2xhc3NlcygpOiBQcm9taXNlPFN0b3JhZ2VDbGFzc1tdPiB7XG4gICAgcmV0dXJuIHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKVxuICAgICAgLnRoZW4oc2NoZW1hc0NvbGxlY3Rpb24gPT4gc2NoZW1hc0NvbGxlY3Rpb24uX2ZldGNoQWxsU2NoZW1hc0Zyb21fU0NIRU1BKCkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBSZXR1cm4gYSBwcm9taXNlIGZvciB0aGUgc2NoZW1hIHdpdGggdGhlIGdpdmVuIG5hbWUsIGluIFBhcnNlIGZvcm1hdC4gSWZcbiAgLy8gdGhpcyBhZGFwdGVyIGRvZXNuJ3Qga25vdyBhYm91dCB0aGUgc2NoZW1hLCByZXR1cm4gYSBwcm9taXNlIHRoYXQgcmVqZWN0cyB3aXRoXG4gIC8vIHVuZGVmaW5lZCBhcyB0aGUgcmVhc29uLlxuICBnZXRDbGFzcyhjbGFzc05hbWU6IHN0cmluZyk6IFByb21pc2U8U3RvcmFnZUNsYXNzPiB7XG4gICAgcmV0dXJuIHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKVxuICAgICAgLnRoZW4oc2NoZW1hc0NvbGxlY3Rpb24gPT4gc2NoZW1hc0NvbGxlY3Rpb24uX2ZldGNoT25lU2NoZW1hRnJvbV9TQ0hFTUEoY2xhc3NOYW1lKSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIFRPRE86IEFzIHlldCBub3QgcGFydGljdWxhcmx5IHdlbGwgc3BlY2lmaWVkLiBDcmVhdGVzIGFuIG9iamVjdC4gTWF5YmUgc2hvdWxkbid0IGV2ZW4gbmVlZCB0aGUgc2NoZW1hLFxuICAvLyBhbmQgc2hvdWxkIGluZmVyIGZyb20gdGhlIHR5cGUuIE9yIG1heWJlIGRvZXMgbmVlZCB0aGUgc2NoZW1hIGZvciB2YWxpZGF0aW9ucy4gT3IgbWF5YmUgbmVlZHNcbiAgLy8gdGhlIHNjaGVtYSBvbmx5IGZvciB0aGUgbGVnYWN5IG1vbmdvIGZvcm1hdC4gV2UnbGwgZmlndXJlIHRoYXQgb3V0IGxhdGVyLlxuICBjcmVhdGVPYmplY3QoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgb2JqZWN0OiBhbnksIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55KSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvT2JqZWN0ID0gcGFyc2VPYmplY3RUb01vbmdvT2JqZWN0Rm9yQ3JlYXRlKGNsYXNzTmFtZSwgb2JqZWN0LCBzY2hlbWEpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLmluc2VydE9uZShtb25nb09iamVjdCwgdHJhbnNhY3Rpb25hbFNlc3Npb24pKVxuICAgICAgLnRoZW4oKCkgPT4gKHsgb3BzOiBbbW9uZ29PYmplY3RdIH0pKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IDExMDAwKSB7XG4gICAgICAgICAgbG9nZ2VyLmVycm9yKCdEdXBsaWNhdGUga2V5IGVycm9yOicsIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgIGNvbnN0IGVyciA9IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICk7XG4gICAgICAgICAgZXJyLnVuZGVybHlpbmdFcnJvciA9IGVycm9yO1xuICAgICAgICAgIGlmIChlcnJvci5tZXNzYWdlKSB7XG4gICAgICAgICAgICBjb25zdCBtYXRjaGVzID0gZXJyb3IubWVzc2FnZS5tYXRjaCgvaW5kZXg6W1xcc2EtekEtWjAtOV9cXC1cXC5dK1xcJD8oW2EtekEtWl8tXSspXzEvKTtcbiAgICAgICAgICAgIGlmIChtYXRjaGVzICYmIEFycmF5LmlzQXJyYXkobWF0Y2hlcykpIHtcbiAgICAgICAgICAgICAgZXJyLnVzZXJJbmZvID0geyBkdXBsaWNhdGVkX2ZpZWxkOiBtYXRjaGVzWzFdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBDaGVjayBmb3IgYXV0aERhdGEgdW5pcXVlIGluZGV4IHZpb2xhdGlvbnNcbiAgICAgICAgICAgIGlmICghZXJyLnVzZXJJbmZvKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGF1dGhEYXRhTWF0Y2ggPSBlcnJvci5tZXNzYWdlLm1hdGNoKC9pbmRleDpcXHMrKF9hdXRoX2RhdGFfW2EtekEtWjAtOV9dK19pZCkvKTtcbiAgICAgICAgICAgICAgaWYgKGF1dGhEYXRhTWF0Y2gpIHtcbiAgICAgICAgICAgICAgICBlcnIudXNlckluZm8gPSB7IGR1cGxpY2F0ZWRfZmllbGQ6IGF1dGhEYXRhTWF0Y2hbMV0gfTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgY3JlYXRlT2JqZWN0cyhjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBvYmplY3RzOiBhbnksIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55KSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvT2JqZWN0cyA9IG9iamVjdHMubWFwKG9iamVjdCA9PlxuICAgICAgcGFyc2VPYmplY3RUb01vbmdvT2JqZWN0Rm9yQ3JlYXRlKGNsYXNzTmFtZSwgb2JqZWN0LCBzY2hlbWEpXG4gICAgKTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5pbnNlcnRNYW55KG1vbmdvT2JqZWN0cywgdHJhbnNhY3Rpb25hbFNlc3Npb24pKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IDExMDAwKSB7XG4gICAgICAgICAgbG9nZ2VyLmVycm9yKCdEdXBsaWNhdGUga2V5IGVycm9yOicsIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgIGNvbnN0IGVyciA9IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICk7XG4gICAgICAgICAgZXJyLnVuZGVybHlpbmdFcnJvciA9IGVycm9yO1xuICAgICAgICAgIGlmIChlcnJvci5tZXNzYWdlKSB7XG4gICAgICAgICAgICBjb25zdCBtYXRjaGVzID0gZXJyb3IubWVzc2FnZS5tYXRjaChcbiAgICAgICAgICAgICAgL2luZGV4OltcXHNhLXpBLVowLTlfXFwtXFwuXStcXCQ/KFthLXpBLVpfLV0rKV8xL1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmIChtYXRjaGVzICYmIEFycmF5LmlzQXJyYXkobWF0Y2hlcykpIHtcbiAgICAgICAgICAgICAgZXJyLnVzZXJJbmZvID0geyBkdXBsaWNhdGVkX2ZpZWxkOiBtYXRjaGVzWzFdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIWVyci51c2VySW5mbykge1xuICAgICAgICAgICAgICBjb25zdCBhdXRoRGF0YU1hdGNoID0gZXJyb3IubWVzc2FnZS5tYXRjaCgvaW5kZXg6XFxzKyhfYXV0aF9kYXRhX1thLXpBLVowLTlfXStfaWQpLyk7XG4gICAgICAgICAgICAgIGlmIChhdXRoRGF0YU1hdGNoKSB7XG4gICAgICAgICAgICAgICAgZXJyLnVzZXJJbmZvID0geyBkdXBsaWNhdGVkX2ZpZWxkOiBhdXRoRGF0YU1hdGNoWzFdIH07XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIFJlbW92ZSBhbGwgb2JqZWN0cyB0aGF0IG1hdGNoIHRoZSBnaXZlbiBQYXJzZSBRdWVyeS5cbiAgLy8gSWYgbm8gb2JqZWN0cyBtYXRjaCwgcmVqZWN0IHdpdGggT0JKRUNUX05PVF9GT1VORC4gSWYgb2JqZWN0cyBhcmUgZm91bmQgYW5kIGRlbGV0ZWQsIHJlc29sdmUgd2l0aCB1bmRlZmluZWQuXG4gIC8vIElmIHRoZXJlIGlzIHNvbWUgb3RoZXIgZXJyb3IsIHJlamVjdCB3aXRoIElOVEVSTkFMX1NFUlZFUl9FUlJPUi5cbiAgZGVsZXRlT2JqZWN0c0J5UXVlcnkoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgdHJhbnNhY3Rpb25hbFNlc3Npb246ID9hbnlcbiAgKSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiB7XG4gICAgICAgIGNvbnN0IG1vbmdvV2hlcmUgPSB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpO1xuICAgICAgICByZXR1cm4gY29sbGVjdGlvbi5kZWxldGVNYW55KG1vbmdvV2hlcmUsIHRyYW5zYWN0aW9uYWxTZXNzaW9uKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSlcbiAgICAgIC50aGVuKFxuICAgICAgICAoeyBkZWxldGVkQ291bnQgfSkgPT4ge1xuICAgICAgICAgIGlmIChkZWxldGVkQ291bnQgPT09IDApIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnT2JqZWN0IG5vdCBmb3VuZC4nKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9LFxuICAgICAgICAoKSA9PiB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVEVSTkFMX1NFUlZFUl9FUlJPUiwgJ0RhdGFiYXNlIGFkYXB0ZXIgZXJyb3InKTtcbiAgICAgICAgfVxuICAgICAgKTtcbiAgfVxuXG4gIC8vIEFwcGx5IHRoZSB1cGRhdGUgdG8gYWxsIG9iamVjdHMgdGhhdCBtYXRjaCB0aGUgZ2l2ZW4gUGFyc2UgUXVlcnkuXG4gIHVwZGF0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHVwZGF0ZTogYW55LFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1VwZGF0ZSA9IHRyYW5zZm9ybVVwZGF0ZShjbGFzc05hbWUsIHVwZGF0ZSwgc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1doZXJlID0gdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hKTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi51cGRhdGVNYW55KG1vbmdvV2hlcmUsIG1vbmdvVXBkYXRlLCB0cmFuc2FjdGlvbmFsU2Vzc2lvbikpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBBdG9taWNhbGx5IGZpbmRzIGFuZCB1cGRhdGVzIGFuIG9iamVjdCBiYXNlZCBvbiBxdWVyeS5cbiAgLy8gUmV0dXJuIHZhbHVlIG5vdCBjdXJyZW50bHkgd2VsbCBzcGVjaWZpZWQuXG4gIGZpbmRPbmVBbmRVcGRhdGUoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgdXBkYXRlOiBhbnksXG4gICAgdHJhbnNhY3Rpb25hbFNlc3Npb246ID9hbnlcbiAgKSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvVXBkYXRlID0gdHJhbnNmb3JtVXBkYXRlKGNsYXNzTmFtZSwgdXBkYXRlLCBzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvV2hlcmUgPSB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uZmluZE9uZUFuZFVwZGF0ZShtb25nb1doZXJlLCBtb25nb1VwZGF0ZSwge1xuICAgICAgICAgIHJldHVybkRvY3VtZW50OiAnYWZ0ZXInLFxuICAgICAgICAgIHNlc3Npb246IHRyYW5zYWN0aW9uYWxTZXNzaW9uIHx8IHVuZGVmaW5lZCxcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC50aGVuKHJlc3VsdCA9PiBtb25nb09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lLCByZXN1bHQsIHNjaGVtYSkpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gMTEwMDApIHtcbiAgICAgICAgICBsb2dnZXIuZXJyb3IoJ0R1cGxpY2F0ZSBrZXkgZXJyb3I6JywgZXJyb3IubWVzc2FnZSk7XG4gICAgICAgICAgY29uc3QgZXJyID0gbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICAgJ0EgZHVwbGljYXRlIHZhbHVlIGZvciBhIGZpZWxkIHdpdGggdW5pcXVlIHZhbHVlcyB3YXMgcHJvdmlkZWQnXG4gICAgICAgICAgKTtcbiAgICAgICAgICBlcnIudW5kZXJseWluZ0Vycm9yID0gZXJyb3I7XG4gICAgICAgICAgaWYgKGVycm9yLm1lc3NhZ2UpIHtcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoZXMgPSBlcnJvci5tZXNzYWdlLm1hdGNoKC9pbmRleDpbXFxzYS16QS1aMC05X1xcLVxcLl0rXFwkPyhbYS16QS1aXy1dKylfMS8pO1xuICAgICAgICAgICAgaWYgKG1hdGNoZXMgJiYgQXJyYXkuaXNBcnJheShtYXRjaGVzKSkge1xuICAgICAgICAgICAgICBlcnIudXNlckluZm8gPSB7IGR1cGxpY2F0ZWRfZmllbGQ6IG1hdGNoZXNbMV0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghZXJyLnVzZXJJbmZvKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGF1dGhEYXRhTWF0Y2ggPSBlcnJvci5tZXNzYWdlLm1hdGNoKC9pbmRleDpcXHMrKF9hdXRoX2RhdGFfW2EtekEtWjAtOV9dK19pZCkvKTtcbiAgICAgICAgICAgICAgaWYgKGF1dGhEYXRhTWF0Y2gpIHtcbiAgICAgICAgICAgICAgICBlcnIudXNlckluZm8gPSB7IGR1cGxpY2F0ZWRfZmllbGQ6IGF1dGhEYXRhTWF0Y2hbMV0gfTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgdXBkYXRlT2JqZWN0c0J5QnVsayhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgb3BlcmF0aW9uczogYW55LFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBidWxrcyA9IG9wZXJhdGlvbnMubWFwKCh7IHVwZGF0ZU9uZSwgdXBkYXRlTWFueSwgaW5zZXJ0T25lIH0pID0+IHtcbiAgICAgIGlmICh1cGRhdGVPbmUpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICB1cGRhdGVPbmU6IHtcbiAgICAgICAgICAgIGZpbHRlcjogdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCB1cGRhdGVPbmUuZmlsdGVyLCBzY2hlbWEpLFxuICAgICAgICAgICAgdXBkYXRlOiB0cmFuc2Zvcm1VcGRhdGUoY2xhc3NOYW1lLCB1cGRhdGVPbmUudXBkYXRlLCBzY2hlbWEpLFxuICAgICAgICAgICAgdXBzZXJ0OiBmYWxzZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgaWYgKHVwZGF0ZU1hbnkpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICB1cGRhdGVNYW55OiB7XG4gICAgICAgICAgICBmaWx0ZXI6IHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgdXBkYXRlTWFueS5maWx0ZXIsIHNjaGVtYSksXG4gICAgICAgICAgICB1cGRhdGU6IHRyYW5zZm9ybVVwZGF0ZShjbGFzc05hbWUsIHVwZGF0ZU1hbnkudXBkYXRlLCBzY2hlbWEpLFxuICAgICAgICAgICAgdXBzZXJ0OiBmYWxzZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgaW5zZXJ0T25lOiB7XG4gICAgICAgICAgZG9jdW1lbnQ6IHBhcnNlT2JqZWN0VG9Nb25nb09iamVjdEZvckNyZWF0ZShjbGFzc05hbWUsIGluc2VydE9uZS5kb2N1bWVudCwgc2NoZW1hKSxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+XG4gICAgICAgIGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5idWxrV3JpdGUoYnVsa3MsIHtcbiAgICAgICAgICBzZXNzaW9uOiB0cmFuc2FjdGlvbmFsU2Vzc2lvbiB8fCB1bmRlZmluZWQsXG4gICAgICAgICAgb3JkZXJlZDogZmFsc2UsXG4gICAgICAgICAgYnlwYXNzRG9jdW1lbnRWYWxpZGF0aW9uOiB0cnVlLFxuICAgICAgICAgIHdyaXRlQ29uY2VybjogeyB3OiAwLCBqOiBmYWxzZSB9LFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLnRoZW4ocmVzdWx0ID0+IG1vbmdvT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIHJlc3VsdC52YWx1ZSwgc2NoZW1hKSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSAxMTAwMCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gSG9wZWZ1bGx5IHdlIGNhbiBnZXQgcmlkIG9mIHRoaXMuIEl0J3Mgb25seSB1c2VkIGZvciBjb25maWcgYW5kIGhvb2tzLlxuICB1cHNlcnRPbmVPYmplY3QoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgdXBkYXRlOiBhbnksXG4gICAgdHJhbnNhY3Rpb25hbFNlc3Npb246ID9hbnlcbiAgKSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvVXBkYXRlID0gdHJhbnNmb3JtVXBkYXRlKGNsYXNzTmFtZSwgdXBkYXRlLCBzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvV2hlcmUgPSB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLnVwc2VydE9uZShtb25nb1doZXJlLCBtb25nb1VwZGF0ZSwgdHJhbnNhY3Rpb25hbFNlc3Npb24pKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gRXhlY3V0ZXMgYSBmaW5kLiBBY2NlcHRzOiBjbGFzc05hbWUsIHF1ZXJ5IGluIFBhcnNlIGZvcm1hdCwgYW5kIHsgc2tpcCwgbGltaXQsIHNvcnQgfS5cbiAgZmluZChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICB7XG4gICAgICBza2lwLFxuICAgICAgbGltaXQsXG4gICAgICBzb3J0LFxuICAgICAga2V5cyxcbiAgICAgIHJlYWRQcmVmZXJlbmNlLFxuICAgICAgaGludCxcbiAgICAgIGNhc2VJbnNlbnNpdGl2ZSxcbiAgICAgIGV4cGxhaW4sXG4gICAgICBjb21tZW50LFxuICAgIH06IFF1ZXJ5T3B0aW9uc1xuICApOiBQcm9taXNlPGFueT4ge1xuICAgIHZhbGlkYXRlRXhwbGFpblZhbHVlKGV4cGxhaW4pO1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1doZXJlID0gdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1NvcnQgPSBfLm1hcEtleXMoc29ydCwgKHZhbHVlLCBmaWVsZE5hbWUpID0+XG4gICAgICB0cmFuc2Zvcm1LZXkoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHNjaGVtYSlcbiAgICApO1xuICAgIGNvbnN0IG1vbmdvS2V5cyA9IF8ucmVkdWNlKFxuICAgICAga2V5cyxcbiAgICAgIChtZW1vLCBrZXkpID0+IHtcbiAgICAgICAgaWYgKGtleSA9PT0gJ0FDTCcpIHtcbiAgICAgICAgICBtZW1vWydfcnBlcm0nXSA9IDE7XG4gICAgICAgICAgbWVtb1snX3dwZXJtJ10gPSAxO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIG1lbW9bdHJhbnNmb3JtS2V5KGNsYXNzTmFtZSwga2V5LCBzY2hlbWEpXSA9IDE7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG1lbW87XG4gICAgICB9LFxuICAgICAge31cbiAgICApO1xuXG4gICAgLy8gSWYgd2UgYXJlbid0IHJlcXVlc3RpbmcgdGhlIGBfaWRgIGZpZWxkLCB3ZSBuZWVkIHRvIGV4cGxpY2l0bHkgb3B0IG91dFxuICAgIC8vIG9mIGl0LiBEb2luZyBzbyBpbiBwYXJzZS1zZXJ2ZXIgaXMgdW51c3VhbCwgYnV0IGl0IGNhbiBhbGxvdyB1cyB0b1xuICAgIC8vIG9wdGltaXplIHNvbWUgcXVlcmllcyB3aXRoIGNvdmVyaW5nIGluZGV4ZXMuXG4gICAgaWYgKGtleXMgJiYgIW1vbmdvS2V5cy5faWQpIHtcbiAgICAgIG1vbmdvS2V5cy5faWQgPSAwO1xuICAgIH1cblxuICAgIHJlYWRQcmVmZXJlbmNlID0gdGhpcy5fcGFyc2VSZWFkUHJlZmVyZW5jZShyZWFkUHJlZmVyZW5jZSk7XG4gICAgcmV0dXJuIHRoaXMuY3JlYXRlVGV4dEluZGV4ZXNJZk5lZWRlZChjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpXG4gICAgICAudGhlbigoKSA9PiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT5cbiAgICAgICAgY29sbGVjdGlvbi5maW5kKG1vbmdvV2hlcmUsIHtcbiAgICAgICAgICBza2lwLFxuICAgICAgICAgIGxpbWl0LFxuICAgICAgICAgIHNvcnQ6IG1vbmdvU29ydCxcbiAgICAgICAgICBrZXlzOiBtb25nb0tleXMsXG4gICAgICAgICAgbWF4VGltZU1TOiB0aGlzLl9tYXhUaW1lTVMsXG4gICAgICAgICAgYmF0Y2hTaXplOiB0aGlzLl9iYXRjaFNpemUsXG4gICAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICAgICAgaGludCxcbiAgICAgICAgICBjYXNlSW5zZW5zaXRpdmUsXG4gICAgICAgICAgZXhwbGFpbixcbiAgICAgICAgICBjb21tZW50LFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLnRoZW4ob2JqZWN0cyA9PiB7XG4gICAgICAgIGlmIChleHBsYWluKSB7XG4gICAgICAgICAgcmV0dXJuIG9iamVjdHM7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG9iamVjdHMubWFwKG9iamVjdCA9PiBtb25nb09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lLCBvYmplY3QsIHNjaGVtYSkpO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGVuc3VyZUluZGV4KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBmaWVsZE5hbWVzOiBzdHJpbmdbXSxcbiAgICBpbmRleE5hbWU6ID9zdHJpbmcsXG4gICAgY2FzZUluc2Vuc2l0aXZlOiBib29sZWFuID0gZmFsc2UsXG4gICAgb3B0aW9ucz86IE9iamVjdCA9IHt9XG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IGluZGV4Q3JlYXRpb25SZXF1ZXN0ID0ge307XG4gICAgY29uc3QgbW9uZ29GaWVsZE5hbWVzID0gZmllbGROYW1lcy5tYXAoZmllbGROYW1lID0+IHRyYW5zZm9ybUtleShjbGFzc05hbWUsIGZpZWxkTmFtZSwgc2NoZW1hKSk7XG4gICAgbW9uZ29GaWVsZE5hbWVzLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgIGluZGV4Q3JlYXRpb25SZXF1ZXN0W2ZpZWxkTmFtZV0gPSBvcHRpb25zLmluZGV4VHlwZSAhPT0gdW5kZWZpbmVkID8gb3B0aW9ucy5pbmRleFR5cGUgOiAxO1xuICAgIH0pO1xuXG4gICAgY29uc3QgZGVmYXVsdE9wdGlvbnM6IE9iamVjdCA9IHsgYmFja2dyb3VuZDogdHJ1ZSwgc3BhcnNlOiB0cnVlIH07XG4gICAgY29uc3QgaW5kZXhOYW1lT3B0aW9uczogT2JqZWN0ID0gaW5kZXhOYW1lID8geyBuYW1lOiBpbmRleE5hbWUgfSA6IHt9O1xuICAgIGNvbnN0IHR0bE9wdGlvbnM6IE9iamVjdCA9IG9wdGlvbnMudHRsICE9PSB1bmRlZmluZWQgPyB7IGV4cGlyZUFmdGVyU2Vjb25kczogb3B0aW9ucy50dGwgfSA6IHt9O1xuICAgIGNvbnN0IHNwYXJzZU9wdGlvbnM6IE9iamVjdCA9IG9wdGlvbnMuc3BhcnNlICE9PSB1bmRlZmluZWQgPyB7IHNwYXJzZTogb3B0aW9ucy5zcGFyc2UgfSA6IHt9O1xuICAgIGNvbnN0IGNhc2VJbnNlbnNpdGl2ZU9wdGlvbnM6IE9iamVjdCA9IGNhc2VJbnNlbnNpdGl2ZVxuICAgICAgPyB7IGNvbGxhdGlvbjogTW9uZ29Db2xsZWN0aW9uLmNhc2VJbnNlbnNpdGl2ZUNvbGxhdGlvbigpIH1cbiAgICAgIDoge307XG4gICAgY29uc3QgcGFydGlhbEZpbHRlck9wdGlvbnM6IE9iamVjdCA9XG4gICAgICBvcHRpb25zLnBhcnRpYWxGaWx0ZXJFeHByZXNzaW9uICE9PSB1bmRlZmluZWRcbiAgICAgICAgPyB7IHBhcnRpYWxGaWx0ZXJFeHByZXNzaW9uOiBvcHRpb25zLnBhcnRpYWxGaWx0ZXJFeHByZXNzaW9uIH1cbiAgICAgICAgOiB7fTtcbiAgICBjb25zdCBpbmRleE9wdGlvbnM6IE9iamVjdCA9IHtcbiAgICAgIC4uLmRlZmF1bHRPcHRpb25zLFxuICAgICAgLi4uY2FzZUluc2Vuc2l0aXZlT3B0aW9ucyxcbiAgICAgIC4uLmluZGV4TmFtZU9wdGlvbnMsXG4gICAgICAuLi50dGxPcHRpb25zLFxuICAgICAgLi4uc3BhcnNlT3B0aW9ucyxcbiAgICAgIC4uLnBhcnRpYWxGaWx0ZXJPcHRpb25zLFxuICAgIH07XG5cbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT5cbiAgICAgICAgY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLmNyZWF0ZUluZGV4KGluZGV4Q3JlYXRpb25SZXF1ZXN0LCBpbmRleE9wdGlvbnMpXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBDcmVhdGUgYSB1bmlxdWUgaW5kZXguIFVuaXF1ZSBpbmRleGVzIG9uIG51bGxhYmxlIGZpZWxkcyBhcmUgbm90IGFsbG93ZWQuIFNpbmNlIHdlIGRvbid0XG4gIC8vIGN1cnJlbnRseSBrbm93IHdoaWNoIGZpZWxkcyBhcmUgbnVsbGFibGUgYW5kIHdoaWNoIGFyZW4ndCwgd2UgaWdub3JlIHRoYXQgY3JpdGVyaWEuXG4gIC8vIEFzIHN1Y2gsIHdlIHNob3VsZG4ndCBleHBvc2UgdGhpcyBmdW5jdGlvbiB0byB1c2VycyBvZiBwYXJzZSB1bnRpbCB3ZSBoYXZlIGFuIG91dC1vZi1iYW5kXG4gIC8vIFdheSBvZiBkZXRlcm1pbmluZyBpZiBhIGZpZWxkIGlzIG51bGxhYmxlLiBVbmRlZmluZWQgZG9lc24ndCBjb3VudCBhZ2FpbnN0IHVuaXF1ZW5lc3MsXG4gIC8vIHdoaWNoIGlzIHdoeSB3ZSB1c2Ugc3BhcnNlIGluZGV4ZXMuXG4gIGVuc3VyZVVuaXF1ZW5lc3MoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgZmllbGROYW1lczogc3RyaW5nW10pIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgaW5kZXhDcmVhdGlvblJlcXVlc3QgPSB7fTtcbiAgICBjb25zdCBtb25nb0ZpZWxkTmFtZXMgPSBmaWVsZE5hbWVzLm1hcChmaWVsZE5hbWUgPT4gdHJhbnNmb3JtS2V5KGNsYXNzTmFtZSwgZmllbGROYW1lLCBzY2hlbWEpKTtcbiAgICBtb25nb0ZpZWxkTmFtZXMuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgaW5kZXhDcmVhdGlvblJlcXVlc3RbZmllbGROYW1lXSA9IDE7XG4gICAgfSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uX2Vuc3VyZVNwYXJzZVVuaXF1ZUluZGV4SW5CYWNrZ3JvdW5kKGluZGV4Q3JlYXRpb25SZXF1ZXN0KSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSAxMTAwMCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICdUcmllZCB0byBlbnN1cmUgZmllbGQgdW5pcXVlbmVzcyBmb3IgYSBjbGFzcyB0aGF0IGFscmVhZHkgaGFzIGR1cGxpY2F0ZXMuJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gQ3JlYXRlcyBhIHVuaXF1ZSBzcGFyc2UgaW5kZXggb24gX2F1dGhfZGF0YV88cHJvdmlkZXI+LmlkIHRvIHByZXZlbnRcbiAgLy8gcmFjZSBjb25kaXRpb25zIGR1cmluZyBjb25jdXJyZW50IHNpZ251cHMgd2l0aCB0aGUgc2FtZSBhdXRoRGF0YS5cbiAgZW5zdXJlQXV0aERhdGFVbmlxdWVuZXNzKHByb3ZpZGVyOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKCdfVXNlcicpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+XG4gICAgICAgIGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5jcmVhdGVJbmRleChcbiAgICAgICAgICB7IFtgX2F1dGhfZGF0YV8ke3Byb3ZpZGVyfS5pZGBdOiAxIH0sXG4gICAgICAgICAgeyB1bmlxdWU6IHRydWUsIHNwYXJzZTogdHJ1ZSwgYmFja2dyb3VuZDogdHJ1ZSwgbmFtZTogYF9hdXRoX2RhdGFfJHtwcm92aWRlcn1faWRgIH1cbiAgICAgICAgKVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IDExMDAwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICAgJ1RyaWVkIHRvIGVuc3VyZSBmaWVsZCB1bmlxdWVuZXNzIGZvciBhIGNsYXNzIHRoYXQgYWxyZWFkeSBoYXMgZHVwbGljYXRlcy4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBJZ25vcmUgXCJpbmRleCBhbHJlYWR5IGV4aXN0cyB3aXRoIHNhbWUgbmFtZVwiIG9yIFwiaW5kZXggYWxyZWFkeSBleGlzdHMgd2l0aCBkaWZmZXJlbnQgb3B0aW9uc1wiXG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSA4NSB8fCBlcnJvci5jb2RlID09PSA4Nikge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBVc2VkIGluIHRlc3RzXG4gIF9yYXdGaW5kKGNsYXNzTmFtZTogc3RyaW5nLCBxdWVyeTogUXVlcnlUeXBlKSB7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+XG4gICAgICAgIGNvbGxlY3Rpb24uZmluZChxdWVyeSwge1xuICAgICAgICAgIG1heFRpbWVNUzogdGhpcy5fbWF4VGltZU1TLFxuICAgICAgICAgIGJhdGNoU2l6ZTogdGhpcy5fYmF0Y2hTaXplLFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gRXhlY3V0ZXMgYSBjb3VudC5cbiAgY291bnQoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgcmVhZFByZWZlcmVuY2U6ID9zdHJpbmcsXG4gICAgX2VzdGltYXRlOiA/Ym9vbGVhbixcbiAgICBoaW50OiA/bWl4ZWQsXG4gICAgY29tbWVudDogP3N0cmluZ1xuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgcmVhZFByZWZlcmVuY2UgPSB0aGlzLl9wYXJzZVJlYWRQcmVmZXJlbmNlKHJlYWRQcmVmZXJlbmNlKTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT5cbiAgICAgICAgY29sbGVjdGlvbi5jb3VudCh0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEsIHRydWUpLCB7XG4gICAgICAgICAgbWF4VGltZU1TOiB0aGlzLl9tYXhUaW1lTVMsXG4gICAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICAgICAgaGludCxcbiAgICAgICAgICBjb21tZW50LFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgZGlzdGluY3QoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgcXVlcnk6IFF1ZXJ5VHlwZSwgZmllbGROYW1lOiBzdHJpbmcpIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgaXNQb2ludGVyRmllbGQgPSBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdQb2ludGVyJztcbiAgICBjb25zdCB0cmFuc2Zvcm1GaWVsZCA9IHRyYW5zZm9ybUtleShjbGFzc05hbWUsIGZpZWxkTmFtZSwgc2NoZW1hKTtcblxuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLmRpc3RpbmN0KHRyYW5zZm9ybUZpZWxkLCB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpKVxuICAgICAgKVxuICAgICAgLnRoZW4ob2JqZWN0cyA9PiB7XG4gICAgICAgIG9iamVjdHMgPSBvYmplY3RzLmZpbHRlcihvYmogPT4gb2JqICE9IG51bGwpO1xuICAgICAgICByZXR1cm4gb2JqZWN0cy5tYXAob2JqZWN0ID0+IHtcbiAgICAgICAgICBpZiAoaXNQb2ludGVyRmllbGQpIHtcbiAgICAgICAgICAgIHJldHVybiB0cmFuc2Zvcm1Qb2ludGVyU3RyaW5nKHNjaGVtYSwgZmllbGROYW1lLCBvYmplY3QpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gbW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0KGNsYXNzTmFtZSwgb2JqZWN0LCBzY2hlbWEpO1xuICAgICAgICB9KTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBhZ2dyZWdhdGUoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBhbnksXG4gICAgcGlwZWxpbmU6IGFueSxcbiAgICByZWFkUHJlZmVyZW5jZTogP3N0cmluZyxcbiAgICBoaW50OiA/bWl4ZWQsXG4gICAgZXhwbGFpbj86IGJvb2xlYW4sXG4gICAgY29tbWVudDogP3N0cmluZyxcbiAgICByYXdWYWx1ZXM/OiBib29sZWFuLFxuICAgIHJhd0ZpZWxkTmFtZXM/OiBib29sZWFuXG4gICkge1xuICAgIHZhbGlkYXRlRXhwbGFpblZhbHVlKGV4cGxhaW4pO1xuICAgIGlmIChyYXdWYWx1ZXMpIHtcbiAgICAgIHBpcGVsaW5lID0gRUpTT04uZGVzZXJpYWxpemUocGlwZWxpbmUpO1xuICAgIH1cbiAgICBsZXQgaXNQb2ludGVyRmllbGQgPSBmYWxzZTtcbiAgICBwaXBlbGluZSA9IHBpcGVsaW5lLm1hcChzdGFnZSA9PiB7XG4gICAgICBpZiAoc3RhZ2UuJGdyb3VwKSB7XG4gICAgICAgIHN0YWdlLiRncm91cCA9IHRoaXMuX3BhcnNlQWdncmVnYXRlR3JvdXBBcmdzKHNjaGVtYSwgc3RhZ2UuJGdyb3VwLCByYXdGaWVsZE5hbWVzKTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHN0YWdlLiRncm91cC5faWQgJiZcbiAgICAgICAgICB0eXBlb2Ygc3RhZ2UuJGdyb3VwLl9pZCA9PT0gJ3N0cmluZycgJiZcbiAgICAgICAgICBzdGFnZS4kZ3JvdXAuX2lkLmluZGV4T2YoJyRfcF8nKSA+PSAwXG4gICAgICAgICkge1xuICAgICAgICAgIGlzUG9pbnRlckZpZWxkID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHN0YWdlLiRtYXRjaCkge1xuICAgICAgICBzdGFnZS4kbWF0Y2ggPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUFyZ3Moc2NoZW1hLCBzdGFnZS4kbWF0Y2gsIHJhd1ZhbHVlcywgcmF3RmllbGROYW1lcyk7XG4gICAgICB9XG4gICAgICBpZiAoc3RhZ2UuJHByb2plY3QpIHtcbiAgICAgICAgc3RhZ2UuJHByb2plY3QgPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZVByb2plY3RBcmdzKHNjaGVtYSwgc3RhZ2UuJHByb2plY3QsIHJhd1ZhbHVlcywgcmF3RmllbGROYW1lcyk7XG4gICAgICB9XG4gICAgICBpZiAoc3RhZ2UuJGdlb05lYXIgJiYgc3RhZ2UuJGdlb05lYXIucXVlcnkpIHtcbiAgICAgICAgc3RhZ2UuJGdlb05lYXIucXVlcnkgPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUFyZ3Moc2NoZW1hLCBzdGFnZS4kZ2VvTmVhci5xdWVyeSwgcmF3VmFsdWVzLCByYXdGaWVsZE5hbWVzKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBzdGFnZTtcbiAgICB9KTtcbiAgICByZWFkUHJlZmVyZW5jZSA9IHRoaXMuX3BhcnNlUmVhZFByZWZlcmVuY2UocmVhZFByZWZlcmVuY2UpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLmFnZ3JlZ2F0ZShwaXBlbGluZSwge1xuICAgICAgICAgIHJlYWRQcmVmZXJlbmNlLFxuICAgICAgICAgIG1heFRpbWVNUzogdGhpcy5fbWF4VGltZU1TLFxuICAgICAgICAgIGJhdGNoU2l6ZTogdGhpcy5fYmF0Y2hTaXplLFxuICAgICAgICAgIGhpbnQsXG4gICAgICAgICAgZXhwbGFpbixcbiAgICAgICAgICBjb21tZW50LFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIGlmIChyYXdGaWVsZE5hbWVzKSB7XG4gICAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICAgIH1cbiAgICAgICAgcmVzdWx0cy5mb3JFYWNoKHJlc3VsdCA9PiB7XG4gICAgICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChyZXN1bHQsICdfaWQnKSkge1xuICAgICAgICAgICAgaWYgKGlzUG9pbnRlckZpZWxkICYmIHJlc3VsdC5faWQpIHtcbiAgICAgICAgICAgICAgcmVzdWx0Ll9pZCA9IHJlc3VsdC5faWQuc3BsaXQoJyQnKVsxXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgcmVzdWx0Ll9pZCA9PSBudWxsIHx8XG4gICAgICAgICAgICAgIHJlc3VsdC5faWQgPT0gdW5kZWZpbmVkIHx8XG4gICAgICAgICAgICAgIChbJ29iamVjdCcsICdzdHJpbmcnXS5pbmNsdWRlcyh0eXBlb2YgcmVzdWx0Ll9pZCkgJiYgXy5pc0VtcHR5KHJlc3VsdC5faWQpKVxuICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgIHJlc3VsdC5faWQgPSBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmVzdWx0Lm9iamVjdElkID0gcmVzdWx0Ll9pZDtcbiAgICAgICAgICAgIGRlbGV0ZSByZXN1bHQuX2lkO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByZXN1bHRzO1xuICAgICAgfSlcbiAgICAgIC50aGVuKG9iamVjdHMgPT4ge1xuICAgICAgICBpZiAocmF3VmFsdWVzKSB7XG4gICAgICAgICAgcmV0dXJuIG9iamVjdHMubWFwKG9iaiA9PiBFSlNPTi5zZXJpYWxpemUob2JqKSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJhd0ZpZWxkTmFtZXMpIHtcbiAgICAgICAgICByZXR1cm4gb2JqZWN0cztcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gb2JqZWN0cy5tYXAob2JqZWN0ID0+IG1vbmdvT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKSk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gVGhpcyBmdW5jdGlvbiB3aWxsIHJlY3Vyc2l2ZWx5IHRyYXZlcnNlIHRoZSBwaXBlbGluZSBhbmQgY29udmVydCBhbnkgUG9pbnRlciBjb2x1bW5zLlxuICAvLyBJZiB3ZSBkZXRlY3QgYSBwb2ludGVyIGNvbHVtbiB3ZSB3aWxsIHJlbmFtZSB0aGUgY29sdW1uIGJlaW5nIHF1ZXJpZWQgZm9yIHRvIG1hdGNoIHRoZSBjb2x1bW5cbiAgLy8gaW4gdGhlIGRhdGFiYXNlLiBXZSBhbHNvIG1vZGlmeSB0aGUgdmFsdWUgdG8gd2hhdCB3ZSBleHBlY3QgdGhlIHZhbHVlIHRvIGJlIGluIHRoZSBkYXRhYmFzZVxuICAvLyBhcyB3ZWxsLlxuICAvLyBGb3IgZGF0ZXMsIHRoZSBkcml2ZXIgZXhwZWN0cyBhIERhdGUgb2JqZWN0LCBidXQgd2UgaGF2ZSBhIHN0cmluZyBjb21pbmcgaW4uIFNvIHdlJ2xsIGNvbnZlcnRcbiAgLy8gdGhlIHN0cmluZyB0byBhIERhdGUgc28gdGhlIGRyaXZlciBjYW4gcGVyZm9ybSB0aGUgbmVjZXNzYXJ5IGNvbXBhcmlzb24uXG4gIC8vXG4gIC8vIFRoZSBnb2FsIG9mIHRoaXMgbWV0aG9kIGlzIHRvIGxvb2sgZm9yIHRoZSBcImxlYXZlc1wiIG9mIHRoZSBwaXBlbGluZSBhbmQgZGV0ZXJtaW5lIGlmIGl0IG5lZWRzXG4gIC8vIHRvIGJlIGNvbnZlcnRlZC4gVGhlIHBpcGVsaW5lIGNhbiBoYXZlIGEgZmV3IGRpZmZlcmVudCBmb3Jtcy4gRm9yIG1vcmUgZGV0YWlscywgc2VlOlxuICAvLyAgICAgaHR0cHM6Ly9kb2NzLm1vbmdvZGIuY29tL21hbnVhbC9yZWZlcmVuY2Uvb3BlcmF0b3IvYWdncmVnYXRpb24vXG4gIC8vXG4gIC8vIElmIHRoZSBwaXBlbGluZSBpcyBhbiBhcnJheSwgaXQgbWVhbnMgd2UgYXJlIHByb2JhYmx5IHBhcnNpbmcgYW4gJyRhbmQnIG9yICckb3InIG9wZXJhdG9yLiBJblxuICAvLyB0aGF0IGNhc2Ugd2UgbmVlZCB0byBsb29wIHRocm91Z2ggYWxsIG9mIGl0J3MgY2hpbGRyZW4gdG8gZmluZCB0aGUgY29sdW1ucyBiZWluZyBvcGVyYXRlZCBvbi5cbiAgLy8gSWYgdGhlIHBpcGVsaW5lIGlzIGFuIG9iamVjdCwgdGhlbiB3ZSdsbCBsb29wIHRocm91Z2ggdGhlIGtleXMgY2hlY2tpbmcgdG8gc2VlIGlmIHRoZSBrZXkgbmFtZVxuICAvLyBtYXRjaGVzIG9uZSBvZiB0aGUgc2NoZW1hIGNvbHVtbnMuIElmIGl0IGRvZXMgbWF0Y2ggYSBQb2ludGVyIGNvbHVtbiwgdGhlbiB3ZSdsbCBjb252ZXJ0IHRoZVxuICAvLyB2YWx1ZSBhcyBkZXNjcmliZWQgYWJvdmUuIERhdGUgdmFsdWVzIGFyZSBsZWZ0IHVudG91Y2hlZCB0byBhdm9pZCBjb3JydXB0aW5nIG5hdGl2ZSBNb25nb0RCXG4gIC8vIGFnZ3JlZ2F0aW9uIGV4cHJlc3Npb25zLlxuICAvL1xuICAvLyBBcyBtdWNoIGFzIEkgaGF0ZSByZWN1cnNpb24uLi50aGlzIHNlZW1lZCBsaWtlIGEgZ29vZCBmaXQgZm9yIGl0LiBXZSdyZSBlc3NlbnRpYWxseSB0cmF2ZXJzaW5nXG4gIC8vIGRvd24gYSB0cmVlIHRvIGZpbmQgYSBcImxlYWYgbm9kZVwiIGFuZCBjaGVja2luZyB0byBzZWUgaWYgaXQgbmVlZHMgdG8gYmUgY29udmVydGVkLlxuICBfcGFyc2VBZ2dyZWdhdGVBcmdzKHNjaGVtYTogYW55LCBwaXBlbGluZTogYW55LCByYXdWYWx1ZXM/OiBib29sZWFuLCByYXdGaWVsZE5hbWVzPzogYm9vbGVhbik6IGFueSB7XG4gICAgaWYgKHBpcGVsaW5lID09PSBudWxsKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9IGVsc2UgaWYgKFV0aWxzLmlzRGF0ZShwaXBlbGluZSkpIHtcbiAgICAgIHJldHVybiBwaXBlbGluZTtcbiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkocGlwZWxpbmUpKSB7XG4gICAgICByZXR1cm4gcGlwZWxpbmUubWFwKHZhbHVlID0+IHRoaXMuX3BhcnNlQWdncmVnYXRlQXJncyhzY2hlbWEsIHZhbHVlLCByYXdWYWx1ZXMsIHJhd0ZpZWxkTmFtZXMpKTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBwaXBlbGluZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgIGNvbnN0IHJldHVyblZhbHVlID0ge307XG4gICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHBpcGVsaW5lKSB7XG4gICAgICAgIGlmICghcmF3RmllbGROYW1lcyAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgICBpZiAodHlwZW9mIHBpcGVsaW5lW2ZpZWxkXSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIHJldHVyblZhbHVlW2BfcF8ke2ZpZWxkfWBdID0gcGlwZWxpbmVbZmllbGRdO1xuICAgICAgICAgIH0gZWxzZSBpZiAocmF3VmFsdWVzKSB7XG4gICAgICAgICAgICByZXR1cm5WYWx1ZVtgX3BfJHtmaWVsZH1gXSA9IHBpcGVsaW5lW2ZpZWxkXTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuVmFsdWVbYF9wXyR7ZmllbGR9YF0gPSBgJHtzY2hlbWEuZmllbGRzW2ZpZWxkXS50YXJnZXRDbGFzc30kJHtwaXBlbGluZVtmaWVsZF19YDtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmV0dXJuVmFsdWVbZmllbGRdID0gdGhpcy5fcGFyc2VBZ2dyZWdhdGVBcmdzKHNjaGVtYSwgcGlwZWxpbmVbZmllbGRdLCByYXdWYWx1ZXMsIHJhd0ZpZWxkTmFtZXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFyYXdGaWVsZE5hbWVzKSB7XG4gICAgICAgICAgaWYgKGZpZWxkID09PSAnb2JqZWN0SWQnKSB7XG4gICAgICAgICAgICByZXR1cm5WYWx1ZVsnX2lkJ10gPSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgICAgICBkZWxldGUgcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGQgPT09ICdjcmVhdGVkQXQnKSB7XG4gICAgICAgICAgICByZXR1cm5WYWx1ZVsnX2NyZWF0ZWRfYXQnXSA9IHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgICAgIGRlbGV0ZSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gJ3VwZGF0ZWRBdCcpIHtcbiAgICAgICAgICAgIHJldHVyblZhbHVlWydfdXBkYXRlZF9hdCddID0gcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICAgICAgZGVsZXRlIHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiByZXR1cm5WYWx1ZTtcbiAgICB9XG4gICAgcmV0dXJuIHBpcGVsaW5lO1xuICB9XG5cbiAgLy8gVGhpcyBmdW5jdGlvbiBpcyBzbGlnaHRseSBkaWZmZXJlbnQgdGhhbiB0aGUgb25lIGFib3ZlLiBSYXRoZXIgdGhhbiB0cnlpbmcgdG8gY29tYmluZSB0aGVzZVxuICAvLyB0d28gZnVuY3Rpb25zIGFuZCBtYWtpbmcgdGhlIGNvZGUgZXZlbiBoYXJkZXIgdG8gdW5kZXJzdGFuZCwgSSBkZWNpZGVkIHRvIHNwbGl0IGl0IHVwLiBUaGVcbiAgLy8gZGlmZmVyZW5jZSB3aXRoIHRoaXMgZnVuY3Rpb24gaXMgd2UgYXJlIG5vdCB0cmFuc2Zvcm1pbmcgdGhlIHZhbHVlcywgb25seSB0aGUga2V5cyBvZiB0aGVcbiAgLy8gcGlwZWxpbmUuXG4gIF9wYXJzZUFnZ3JlZ2F0ZVByb2plY3RBcmdzKHNjaGVtYTogYW55LCBwaXBlbGluZTogYW55LCByYXdWYWx1ZXM/OiBib29sZWFuLCByYXdGaWVsZE5hbWVzPzogYm9vbGVhbik6IGFueSB7XG4gICAgY29uc3QgcmV0dXJuVmFsdWUgPSB7fTtcbiAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHBpcGVsaW5lKSB7XG4gICAgICBpZiAoIXJhd0ZpZWxkTmFtZXMgJiYgc2NoZW1hLmZpZWxkc1tmaWVsZF0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSA9PT0gJ1BvaW50ZXInKSB7XG4gICAgICAgIHJldHVyblZhbHVlW2BfcF8ke2ZpZWxkfWBdID0gcGlwZWxpbmVbZmllbGRdO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuVmFsdWVbZmllbGRdID0gdGhpcy5fcGFyc2VBZ2dyZWdhdGVBcmdzKHNjaGVtYSwgcGlwZWxpbmVbZmllbGRdLCByYXdWYWx1ZXMsIHJhd0ZpZWxkTmFtZXMpO1xuICAgICAgfVxuXG4gICAgICBpZiAoIXJhd0ZpZWxkTmFtZXMpIHtcbiAgICAgICAgaWYgKGZpZWxkID09PSAnb2JqZWN0SWQnKSB7XG4gICAgICAgICAgcmV0dXJuVmFsdWVbJ19pZCddID0gcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICAgIGRlbGV0ZSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgIH0gZWxzZSBpZiAoZmllbGQgPT09ICdjcmVhdGVkQXQnKSB7XG4gICAgICAgICAgcmV0dXJuVmFsdWVbJ19jcmVhdGVkX2F0J10gPSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgICAgZGVsZXRlIHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gJ3VwZGF0ZWRBdCcpIHtcbiAgICAgICAgICByZXR1cm5WYWx1ZVsnX3VwZGF0ZWRfYXQnXSA9IHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgICBkZWxldGUgcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiByZXR1cm5WYWx1ZTtcbiAgfVxuXG4gIC8vIFRoaXMgZnVuY3Rpb24gaXMgc2xpZ2h0bHkgZGlmZmVyZW50IHRoYW4gdGhlIHR3byBhYm92ZS4gTW9uZ29EQiAkZ3JvdXAgYWdncmVnYXRlIGxvb2tzIGxpa2U6XG4gIC8vICAgICB7ICRncm91cDogeyBfaWQ6IDxleHByZXNzaW9uPiwgPGZpZWxkMT46IHsgPGFjY3VtdWxhdG9yMT4gOiA8ZXhwcmVzc2lvbjE+IH0sIC4uLiB9IH1cbiAgLy8gVGhlIDxleHByZXNzaW9uPiBjb3VsZCBiZSBhIGNvbHVtbiBuYW1lLCBwcmVmaXhlZCB3aXRoIHRoZSAnJCcgY2hhcmFjdGVyLiBXZSdsbCBsb29rIGZvclxuICAvLyB0aGVzZSA8ZXhwcmVzc2lvbj4gYW5kIGNoZWNrIHRvIHNlZSBpZiBpdCBpcyBhICdQb2ludGVyJyBvciBpZiBpdCdzIG9uZSBvZiBjcmVhdGVkQXQsXG4gIC8vIHVwZGF0ZWRBdCBvciBvYmplY3RJZCBhbmQgY2hhbmdlIGl0IGFjY29yZGluZ2x5LlxuICBfcGFyc2VBZ2dyZWdhdGVHcm91cEFyZ3Moc2NoZW1hOiBhbnksIHBpcGVsaW5lOiBhbnksIHJhd0ZpZWxkTmFtZXM/OiBib29sZWFuKTogYW55IHtcbiAgICBpZiAoQXJyYXkuaXNBcnJheShwaXBlbGluZSkpIHtcbiAgICAgIHJldHVybiBwaXBlbGluZS5tYXAodmFsdWUgPT4gdGhpcy5fcGFyc2VBZ2dyZWdhdGVHcm91cEFyZ3Moc2NoZW1hLCB2YWx1ZSwgcmF3RmllbGROYW1lcykpO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHBpcGVsaW5lID09PSAnb2JqZWN0Jykge1xuICAgICAgY29uc3QgcmV0dXJuVmFsdWUgPSB7fTtcbiAgICAgIGZvciAoY29uc3QgZmllbGQgaW4gcGlwZWxpbmUpIHtcbiAgICAgICAgcmV0dXJuVmFsdWVbZmllbGRdID0gdGhpcy5fcGFyc2VBZ2dyZWdhdGVHcm91cEFyZ3Moc2NoZW1hLCBwaXBlbGluZVtmaWVsZF0sIHJhd0ZpZWxkTmFtZXMpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJldHVyblZhbHVlO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHBpcGVsaW5lID09PSAnc3RyaW5nJyAmJiAhcmF3RmllbGROYW1lcykge1xuICAgICAgY29uc3QgZmllbGQgPSBwaXBlbGluZS5zdWJzdHJpbmcoMSk7XG4gICAgICBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZF0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSA9PT0gJ1BvaW50ZXInKSB7XG4gICAgICAgIHJldHVybiBgJF9wXyR7ZmllbGR9YDtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGQgPT0gJ2NyZWF0ZWRBdCcpIHtcbiAgICAgICAgcmV0dXJuICckX2NyZWF0ZWRfYXQnO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PSAndXBkYXRlZEF0Jykge1xuICAgICAgICByZXR1cm4gJyRfdXBkYXRlZF9hdCc7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBwaXBlbGluZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZWN1cnNpdmVseSBjb252ZXJ0cyB2YWx1ZXMgdG8gRGF0ZSBvYmplY3RzLiBTaW5jZSB0aGUgcGFzc2VkIG9iamVjdCBpcyBwYXJ0IG9mIGFuIGFnZ3JlZ2F0aW9uXG4gICAqIHBpcGVsaW5lIGFuZCBjYW4gY29udGFpbiB2YXJpb3VzIGxvZ2ljIG9wZXJhdG9ycyAobGlrZSAkZ3QsICRsdCwgZXRjKSwgdGhpcyBmdW5jdGlvbiB3aWxsXG4gICAqIHRyYXZlcnNlIHRoZSBvYmplY3QgYW5kIGNvbnZlcnQgYW55IHN0cmluZ3MgdGhhdCBjYW4gYmUgcGFyc2VkIGFzIGRhdGVzIGludG8gRGF0ZSBvYmplY3RzLlxuICAgKiBAcGFyYW0ge2FueX0gdmFsdWUgVGhlIHZhbHVlIHRvIGNvbnZlcnQuXG4gICAqIEByZXR1cm5zIHthbnl9IFRoZSBvcmlnaW5hbCB2YWx1ZSBpZiBub3QgY29udmVydGlibGUgdG8gRGF0ZSwgb3IgYSBEYXRlIG9iamVjdCBpZiBpdCBpcy5cbiAgICovXG4gIF9jb252ZXJ0VG9EYXRlKHZhbHVlOiBhbnkpOiBhbnkge1xuICAgIGlmIChVdGlscy5pc0RhdGUodmFsdWUpKSB7XG4gICAgICByZXR1cm4gdmFsdWU7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICByZXR1cm4gaXNOYU4oRGF0ZS5wYXJzZSh2YWx1ZSkpID8gdmFsdWUgOiBuZXcgRGF0ZSh2YWx1ZSk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICBjb25zdCByZXR1cm5WYWx1ZSA9IHt9O1xuICAgICAgZm9yIChjb25zdCBmaWVsZCBpbiB2YWx1ZSkge1xuICAgICAgICByZXR1cm5WYWx1ZVtmaWVsZF0gPSB0aGlzLl9jb252ZXJ0VG9EYXRlKHZhbHVlW2ZpZWxkXSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gcmV0dXJuVmFsdWU7XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxuXG4gIF9wYXJzZVJlYWRQcmVmZXJlbmNlKHJlYWRQcmVmZXJlbmNlOiA/c3RyaW5nKTogP3N0cmluZyB7XG4gICAgaWYgKHJlYWRQcmVmZXJlbmNlKSB7XG4gICAgICByZWFkUHJlZmVyZW5jZSA9IHJlYWRQcmVmZXJlbmNlLnRvVXBwZXJDYXNlKCk7XG4gICAgfVxuICAgIHN3aXRjaCAocmVhZFByZWZlcmVuY2UpIHtcbiAgICAgIGNhc2UgJ1BSSU1BUlknOlxuICAgICAgICByZWFkUHJlZmVyZW5jZSA9IFJlYWRQcmVmZXJlbmNlLlBSSU1BUlk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnUFJJTUFSWV9QUkVGRVJSRUQnOlxuICAgICAgICByZWFkUHJlZmVyZW5jZSA9IFJlYWRQcmVmZXJlbmNlLlBSSU1BUllfUFJFRkVSUkVEO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ1NFQ09OREFSWSc6XG4gICAgICAgIHJlYWRQcmVmZXJlbmNlID0gUmVhZFByZWZlcmVuY2UuU0VDT05EQVJZO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ1NFQ09OREFSWV9QUkVGRVJSRUQnOlxuICAgICAgICByZWFkUHJlZmVyZW5jZSA9IFJlYWRQcmVmZXJlbmNlLlNFQ09OREFSWV9QUkVGRVJSRUQ7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnTkVBUkVTVCc6XG4gICAgICAgIHJlYWRQcmVmZXJlbmNlID0gUmVhZFByZWZlcmVuY2UuTkVBUkVTVDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIHVuZGVmaW5lZDpcbiAgICAgIGNhc2UgbnVsbDpcbiAgICAgIGNhc2UgJyc6XG4gICAgICAgIGJyZWFrO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksICdOb3Qgc3VwcG9ydGVkIHJlYWQgcHJlZmVyZW5jZS4nKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgcGVyZm9ybUluaXRpYWxpemF0aW9uKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIGNyZWF0ZUluZGV4KGNsYXNzTmFtZTogc3RyaW5nLCBpbmRleDogYW55KSB7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5jcmVhdGVJbmRleChpbmRleCkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBjcmVhdGVJbmRleGVzKGNsYXNzTmFtZTogc3RyaW5nLCBpbmRleGVzOiBhbnkpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLmNyZWF0ZUluZGV4ZXMoaW5kZXhlcykpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBjcmVhdGVJbmRleGVzSWZOZWVkZWQoY2xhc3NOYW1lOiBzdHJpbmcsIGZpZWxkTmFtZTogc3RyaW5nLCB0eXBlOiBhbnkpIHtcbiAgICBpZiAodHlwZSAmJiB0eXBlLnR5cGUgPT09ICdQb2x5Z29uJykge1xuICAgICAgY29uc3QgaW5kZXggPSB7XG4gICAgICAgIFtmaWVsZE5hbWVdOiAnMmRzcGhlcmUnLFxuICAgICAgfTtcbiAgICAgIHJldHVybiB0aGlzLmNyZWF0ZUluZGV4KGNsYXNzTmFtZSwgaW5kZXgpO1xuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICBjcmVhdGVUZXh0SW5kZXhlc0lmTmVlZGVkKGNsYXNzTmFtZTogc3RyaW5nLCBxdWVyeTogUXVlcnlUeXBlLCBzY2hlbWE6IGFueSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGZvciAoY29uc3QgZmllbGROYW1lIGluIHF1ZXJ5KSB7XG4gICAgICBpZiAoIXF1ZXJ5W2ZpZWxkTmFtZV0gfHwgIXF1ZXJ5W2ZpZWxkTmFtZV0uJHRleHQpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBleGlzdGluZ0luZGV4ZXMgPSBzY2hlbWEuaW5kZXhlcztcbiAgICAgIGZvciAoY29uc3Qga2V5IGluIGV4aXN0aW5nSW5kZXhlcykge1xuICAgICAgICBjb25zdCBpbmRleCA9IGV4aXN0aW5nSW5kZXhlc1trZXldO1xuICAgICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGluZGV4LCBmaWVsZE5hbWUpKSB7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBjb25zdCBpbmRleE5hbWUgPSBgJHtmaWVsZE5hbWV9X3RleHRgO1xuICAgICAgY29uc3QgdGV4dEluZGV4ID0ge1xuICAgICAgICBbaW5kZXhOYW1lXTogeyBbZmllbGROYW1lXTogJ3RleHQnIH0sXG4gICAgICB9O1xuICAgICAgcmV0dXJuIHRoaXMuc2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQoXG4gICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgdGV4dEluZGV4LFxuICAgICAgICBleGlzdGluZ0luZGV4ZXMsXG4gICAgICAgIHNjaGVtYS5maWVsZHNcbiAgICAgICkuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gODUpIHtcbiAgICAgICAgICAvLyBJbmRleCBleGlzdCB3aXRoIGRpZmZlcmVudCBvcHRpb25zXG4gICAgICAgICAgcmV0dXJuIHRoaXMuc2V0SW5kZXhlc0Zyb21Nb25nbyhjbGFzc05hbWUpO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIGdldEluZGV4ZXMoY2xhc3NOYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLmluZGV4ZXMoKSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGRyb3BJbmRleChjbGFzc05hbWU6IHN0cmluZywgaW5kZXg6IGFueSkge1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uZHJvcEluZGV4KGluZGV4KSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGRyb3BBbGxJbmRleGVzKGNsYXNzTmFtZTogc3RyaW5nKSB7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5kcm9wSW5kZXhlcygpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgdXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMoKTogUHJvbWlzZTxhbnk+IHtcbiAgICByZXR1cm4gdGhpcy5nZXRBbGxDbGFzc2VzKClcbiAgICAgIC50aGVuKGNsYXNzZXMgPT4ge1xuICAgICAgICBjb25zdCBwcm9taXNlcyA9IGNsYXNzZXMubWFwKHNjaGVtYSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMuc2V0SW5kZXhlc0Zyb21Nb25nbyhzY2hlbWEuY2xhc3NOYW1lKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiBQcm9taXNlLmFsbChwcm9taXNlcyk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgY3JlYXRlVHJhbnNhY3Rpb25hbFNlc3Npb24oKTogUHJvbWlzZTxhbnk+IHtcbiAgICBjb25zdCB0cmFuc2FjdGlvbmFsU2VjdGlvbiA9IHRoaXMuY2xpZW50LnN0YXJ0U2Vzc2lvbigpO1xuICAgIHRyYW5zYWN0aW9uYWxTZWN0aW9uLnN0YXJ0VHJhbnNhY3Rpb24oKTtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHRyYW5zYWN0aW9uYWxTZWN0aW9uKTtcbiAgfVxuXG4gIGNvbW1pdFRyYW5zYWN0aW9uYWxTZXNzaW9uKHRyYW5zYWN0aW9uYWxTZWN0aW9uOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBjb21taXQgPSByZXRyaWVzID0+IHtcbiAgICAgIHJldHVybiB0cmFuc2FjdGlvbmFsU2VjdGlvblxuICAgICAgICAuY29tbWl0VHJhbnNhY3Rpb24oKVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgIGlmIChlcnJvciAmJiBlcnJvci5oYXNFcnJvckxhYmVsKCdUcmFuc2llbnRUcmFuc2FjdGlvbkVycm9yJykgJiYgcmV0cmllcyA+IDApIHtcbiAgICAgICAgICAgIHJldHVybiBjb21taXQocmV0cmllcyAtIDEpO1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIHRyYW5zYWN0aW9uYWxTZWN0aW9uLmVuZFNlc3Npb24oKTtcbiAgICAgICAgfSk7XG4gICAgfTtcbiAgICByZXR1cm4gY29tbWl0KDUpO1xuICB9XG5cbiAgYWJvcnRUcmFuc2FjdGlvbmFsU2Vzc2lvbih0cmFuc2FjdGlvbmFsU2VjdGlvbjogYW55KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIHRyYW5zYWN0aW9uYWxTZWN0aW9uLmFib3J0VHJhbnNhY3Rpb24oKS50aGVuKCgpID0+IHtcbiAgICAgIHRyYW5zYWN0aW9uYWxTZWN0aW9uLmVuZFNlc3Npb24oKTtcbiAgICB9KTtcbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBNb25nb1N0b3JhZ2VBZGFwdGVyO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFDQSxJQUFBQSxXQUFBLEdBQUFDLE9BQUE7QUFFQSxJQUFBQyxlQUFBLEdBQUFELE9BQUE7QUFDQSxJQUFBRSxNQUFBLEdBQUFDLHNCQUFBLENBQUFILE9BQUE7QUFDQSxJQUFBSSxnQkFBQSxHQUFBRCxzQkFBQSxDQUFBSCxPQUFBO0FBQ0EsSUFBQUssc0JBQUEsR0FBQUYsc0JBQUEsQ0FBQUgsT0FBQTtBQUNBLElBQUFNLGVBQUEsR0FBQU4sT0FBQTtBQVNBLElBQUFPLEtBQUEsR0FBQUosc0JBQUEsQ0FBQUgsT0FBQTtBQUVBLElBQUFRLE9BQUEsR0FBQUwsc0JBQUEsQ0FBQUgsT0FBQTtBQUNBLElBQUFTLEtBQUEsR0FBQVQsT0FBQTtBQUNBLElBQUFVLFNBQUEsR0FBQUMsdUJBQUEsQ0FBQVgsT0FBQTtBQUNB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