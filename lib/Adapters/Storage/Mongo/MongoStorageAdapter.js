"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.MongoStorageAdapter = void 0;

var _MongoCollection = _interopRequireDefault(require("./MongoCollection"));

var _MongoSchemaCollection = _interopRequireDefault(require("./MongoSchemaCollection"));

var _StorageAdapter = require("../StorageAdapter");

var _mongodbUrl = require("../../../vendor/mongodbUrl");

var _MongoTransform = require("./MongoTransform");

var _node = _interopRequireDefault(require("parse/node"));

var _lodash = _interopRequireDefault(require("lodash"));

var _defaults = _interopRequireDefault(require("../../../defaults"));

var _logger = _interopRequireDefault(require("../../../logger"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(Object(source), true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(Object(source)).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

function _objectWithoutProperties(source, excluded) { if (source == null) return {}; var target = _objectWithoutPropertiesLoose(source, excluded); var key, i; if (Object.getOwnPropertySymbols) { var sourceSymbolKeys = Object.getOwnPropertySymbols(source); for (i = 0; i < sourceSymbolKeys.length; i++) { key = sourceSymbolKeys[i]; if (excluded.indexOf(key) >= 0) continue; if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue; target[key] = source[key]; } } return target; }

function _objectWithoutPropertiesLoose(source, excluded) { if (source == null) return {}; var target = {}; var sourceKeys = Object.keys(source); var key, i; for (i = 0; i < sourceKeys.length; i++) { key = sourceKeys[i]; if (excluded.indexOf(key) >= 0) continue; target[key] = source[key]; } return target; }

function _extends() { _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return _extends.apply(this, arguments); }

// -disable-next
const mongodb = require('mongodb');

const MongoClient = mongodb.MongoClient;
const ReadPreference = mongodb.ReadPreference;
const MongoSchemaCollectionName = '_SCHEMA';

const storageAdapterAllCollections = mongoAdapter => {
  return mongoAdapter.connect().then(() => mongoAdapter.database.collections()).then(collections => {
    return collections.filter(collection => {
      if (collection.namespace.match(/\.system\./)) {
        return false;
      } // TODO: If you have one app with a collection prefix that happens to be a prefix of another
      // apps prefix, this will go very very badly. We should fix that somehow.


      return collection.collectionName.indexOf(mongoAdapter._collectionPrefix) == 0;
    });
  });
};

const convertParseSchemaToMongoSchema = (_ref) => {
  let schema = _extends({}, _ref);

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
}; // Returns { code, error } if invalid, or { result }, an object
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
    const _fields$fieldName = fields[fieldName],
          {
      type,
      targetClass
    } = _fields$fieldName,
          fieldOptions = _objectWithoutProperties(_fields$fieldName, ["type", "targetClass"]);

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
    this._mongoOptions = mongoOptions;
    this._mongoOptions.useNewUrlParser = true;
    this._mongoOptions.useUnifiedTopology = true;

    this._onchange = () => {}; // MaxTimeMS is not a global MongoDB client option, it is applied per operation.


    this._maxTimeMS = mongoOptions.maxTimeMS;
    this.canSortOnJoinTables = true;
    delete mongoOptions.maxTimeMS;
  }

  watch(callback) {
    this._onchange = callback;
  }

  connect() {
    if (this.connectionPromise) {
      return this.connectionPromise;
    } // parsing and re-formatting causes the auth value (if there) to get URI
    // encoded


    const encodedUri = (0, _mongodbUrl.format)((0, _mongodbUrl.parse)(this._uri));
    this.connectionPromise = MongoClient.connect(encodedUri, this._mongoOptions).then(client => {
      // Starting mongoDB 3.0, the MongoClient.connect don't return a DB anymore but a client
      // Fortunately, we can get back the options and use them to select the proper DB.
      // https://github.com/mongodb/node-mongodb-native/blob/2c35d76f08574225b8db02d7bef687123e6bb018/lib/mongo_client.js#L885
      const options = client.s.options;
      const database = client.db(options.dbName);

      if (!database) {
        delete this.connectionPromise;
        return;
      }

      database.on('error', () => {
        delete this.connectionPromise;
      });
      database.on('close', () => {
        delete this.connectionPromise;
      });
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

    throw error;
  }

  handleShutdown() {
    if (!this.client) {
      return Promise.resolve();
    }

    return this.client.close(false);
  }

  _adaptiveCollection(name) {
    return this.connect().then(() => this.database.collection(this._collectionPrefix + name)).then(rawCollection => new _MongoCollection.default(rawCollection)).catch(err => this.handleError(err));
  }

  _schemaCollection() {
    return this.connect().then(() => this._adaptiveCollection(MongoSchemaCollectionName)).then(collection => {
      if (!this._stream) {
        this._stream = collection._mongoCollection.watch();

        this._stream.on('change', this._onchange);
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
          if (!Object.prototype.hasOwnProperty.call(fields, key)) {
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

  addFieldIfNotExists(className, fieldName, type) {
    return this._schemaCollection().then(schemaCollection => schemaCollection.addFieldIfNotExists(className, fieldName, type)).then(() => this.createIndexesIfNeeded(className, fieldName, type)).catch(err => this.handleError(err));
  } // Drops a collection. Resolves with true if it was a Parse Schema (eg. _User, Custom, etc.)
  // and resolves with false if it wasn't (eg. a join table). Rejects if deletion was impossible.


  deleteClass(className) {
    return this._adaptiveCollection(className).then(collection => collection.drop()).catch(error => {
      // 'ns not found' means collection was already gone. Ignore deletion attempt.
      if (error.message == 'ns not found') {
        return;
      }

      throw error;
    }) // We've dropped the collection, now remove the _SCHEMA document
    .then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.findAndDeleteSchema(className)).catch(err => this.handleError(err));
  }

  deleteAllClasses(fast) {
    return storageAdapterAllCollections(this).then(collections => Promise.all(collections.map(collection => fast ? collection.deleteMany({}) : collection.drop())));
  } // Remove the column and all the data. For Relations, the _Join collection is handled
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
    const schemaUpdate = {
      $unset: {}
    };
    fieldNames.forEach(name => {
      schemaUpdate['$unset'][name] = null;
      schemaUpdate['$unset'][`_metadata.fields_options.${name}`] = null;
    });
    return this._adaptiveCollection(className).then(collection => collection.updateMany({}, collectionUpdate)).then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.updateSchema(className, schemaUpdate)).catch(err => this.handleError(err));
  } // Return a promise for all schemas known to this adapter, in Parse format. In case the
  // schemas cannot be retrieved, returns a promise that rejects. Requirements for the
  // rejection reason are TBD.


  getAllClasses() {
    return this._schemaCollection().then(schemasCollection => schemasCollection._fetchAllSchemasFrom_SCHEMA()).catch(err => this.handleError(err));
  } // Return a promise for the schema with the given name, in Parse format. If
  // this adapter doesn't know about the schema, return a promise that rejects with
  // undefined as the reason.


  getClass(className) {
    return this._schemaCollection().then(schemasCollection => schemasCollection._fetchOneSchemaFrom_SCHEMA(className)).catch(err => this.handleError(err));
  } // TODO: As yet not particularly well specified. Creates an object. Maybe shouldn't even need the schema,
  // and should infer from the type. Or maybe does need the schema for validations. Or maybe needs
  // the schema only for the legacy mongo format. We'll figure that out later.


  createObject(className, schema, object, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoObject = (0, _MongoTransform.parseObjectToMongoObjectForCreate)(className, object, schema);
    return this._adaptiveCollection(className).then(collection => collection.insertOne(mongoObject, transactionalSession)).catch(error => {
      if (error.code === 11000) {
        // Duplicate value
        const err = new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
        err.underlyingError = error;

        if (error.message) {
          const matches = error.message.match(/index:[\sa-zA-Z0-9_\-\.]+\$?([a-zA-Z_-]+)_1/);

          if (matches && Array.isArray(matches)) {
            err.userInfo = {
              duplicated_field: matches[1]
            };
          }
        }

        throw err;
      }

      throw error;
    }).catch(err => this.handleError(err));
  } // Added to allow the creation of multiple objects at once


  createObjects(className, schema, objects, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoObjects = objects.map(object => (0, _MongoTransform.parseObjectToMongoObjectForCreate)(className, object, schema));
    return this._adaptiveCollection(className).then(collection => collection.insertMany(mongoObjects, transactionalSession)).catch(error => {
      if (error.code === 11000) {
        // Duplicate value
        const err = new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
        err.underlyingError = error;

        if (error.message) {
          const matches = error.message.match(/index:[\sa-zA-Z0-9_\-\.]+\$?([a-zA-Z_-]+)_1/);

          if (matches && Array.isArray(matches)) {
            err.userInfo = {
              duplicated_field: matches[1]
            };
          }
        }

        throw err;
      }

      throw error;
    }).catch(err => this.handleError(err));
  } // Remove all objects that match the given Parse Query.
  // If no objects match, reject with OBJECT_NOT_FOUND. If objects are found and deleted, resolve with undefined.
  // If there is some other error, reject with INTERNAL_SERVER_ERROR.


  deleteObjectsByQuery(className, schema, query, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    return this._adaptiveCollection(className).then(collection => {
      const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
      return collection.deleteMany(mongoWhere, transactionalSession);
    }).catch(err => this.handleError(err)).then(({
      result
    }) => {
      if (result.n === 0) {
        throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Object not found.');
      }

      return Promise.resolve();
    }, () => {
      throw new _node.default.Error(_node.default.Error.INTERNAL_SERVER_ERROR, 'Database adapter error');
    });
  } // Apply the update to all objects that match the given Parse Query.


  updateObjectsByQuery(className, schema, query, update, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoUpdate = (0, _MongoTransform.transformUpdate)(className, update, schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    return this._adaptiveCollection(className).then(collection => collection.updateMany(mongoWhere, mongoUpdate, transactionalSession)).catch(err => this.handleError(err));
  } // Atomically finds and updates an object based on query.
  // Return value not currently well specified.


  findOneAndUpdate(className, schema, query, update, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoUpdate = (0, _MongoTransform.transformUpdate)(className, update, schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.findOneAndUpdate(mongoWhere, mongoUpdate, {
      returnOriginal: false,
      session: transactionalSession || undefined
    })).then(result => (0, _MongoTransform.mongoObjectToParseObject)(className, result.value, schema)).catch(error => {
      if (error.code === 11000) {
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
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
      return updateOne ? {
        updateOne: {
          filter: (0, _MongoTransform.transformWhere)(className, updateOne.filter, schema),
          update: (0, _MongoTransform.transformUpdate)(className, updateOne.update, schema),
          upsert: false
        }
      } : updateMany ? {
        updateMany: {
          filter: (0, _MongoTransform.transformWhere)(className, updateMany.filter, schema),
          update: (0, _MongoTransform.transformUpdate)(className, updateMany.update, schema),
          upsert: false
        }
      } : {
        insertOne: {
          document: (0, _MongoTransform.parseObjectToMongoObjectForCreate)(className, insertOne.document, schema)
        }
      };
    });
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.bulkWrite(bulks, {
      session: transactionalSession || undefined
    })).then(result => (0, _MongoTransform.mongoObjectToParseObject)(className, result.value, schema)).catch(error => {
      if (error.code === 11000) {
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
      }

      throw error;
    }).catch(err => this.handleError(err));
  } // Hopefully we can get rid of this. It's only used for config and hooks.


  upsertOneObject(className, schema, query, update, transactionalSession) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoUpdate = (0, _MongoTransform.transformUpdate)(className, update, schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    return this._adaptiveCollection(className).then(collection => collection.upsertOne(mongoWhere, mongoUpdate, transactionalSession)).catch(err => this.handleError(err));
  } // Executes a find. Accepts: className, query in Parse format, and { skip, limit, sort }.


  find(className, schema, query, {
    skip,
    limit,
    sort,
    keys,
    readPreference,
    hint,
    caseInsensitive,
    explain
  }) {
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
    }, {}); // If we aren't requesting the `_id` field, we need to explicitly opt out
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
      readPreference,
      hint,
      caseInsensitive,
      explain
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
    const caseInsensitiveOptions = caseInsensitive ? {
      collation: _MongoCollection.default.caseInsensitiveCollation()
    } : {};

    const indexOptions = _objectSpread(_objectSpread(_objectSpread(_objectSpread({}, defaultOptions), caseInsensitiveOptions), indexNameOptions), ttlOptions);

    return this._adaptiveCollection(className).then(collection => new Promise((resolve, reject) => collection._mongoCollection.createIndex(indexCreationRequest, indexOptions, error => error ? reject(error) : resolve()))).catch(err => this.handleError(err));
  } // Create a unique index. Unique indexes on nullable fields are not allowed. Since we don't
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
  } // Used in tests


  _rawFind(className, query) {
    return this._adaptiveCollection(className).then(collection => collection.find(query, {
      maxTimeMS: this._maxTimeMS
    })).catch(err => this.handleError(err));
  } // Executes a count.


  count(className, schema, query, readPreference, hint) {
    schema = convertParseSchemaToMongoSchema(schema);
    readPreference = this._parseReadPreference(readPreference);
    return this._adaptiveCollection(className).then(collection => collection.count((0, _MongoTransform.transformWhere)(className, query, schema, true), {
      maxTimeMS: this._maxTimeMS,
      readPreference,
      hint
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

  aggregate(className, schema, pipeline, readPreference, hint, explain) {
    let isPointerField = false;
    pipeline = pipeline.map(stage => {
      if (stage.$group) {
        stage.$group = this._parseAggregateGroupArgs(schema, stage.$group);

        if (stage.$group._id && typeof stage.$group._id === 'string' && stage.$group._id.indexOf('$_p_') >= 0) {
          isPointerField = true;
        }
      }

      if (stage.$match) {
        stage.$match = this._parseAggregateArgs(schema, stage.$match);
      }

      if (stage.$project) {
        stage.$project = this._parseAggregateProjectArgs(schema, stage.$project);
      }

      if (stage.$geoNear) {
        stage.$geoNear.query = this._parseAggregateArgs(schema, stage.$geoNear.query);
      }

      return stage;
    });
    readPreference = this._parseReadPreference(readPreference);
    return this._adaptiveCollection(className).then(collection => collection.aggregate(pipeline, {
      readPreference,
      maxTimeMS: this._maxTimeMS,
      hint,
      explain
    })).then(results => {
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
    }).then(objects => objects.map(object => (0, _MongoTransform.mongoObjectToParseObject)(className, object, schema))).catch(err => this.handleError(err));
  } // This function will recursively traverse the pipeline and convert any Pointer or Date columns.
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
  // matches one of the schema columns. If it does match a column and the column is a Pointer or
  // a Date, then we'll convert the value as described above.
  //
  // As much as I hate recursion...this seemed like a good fit for it. We're essentially traversing
  // down a tree to find a "leaf node" and checking to see if it needs to be converted.


  _parseAggregateArgs(schema, pipeline) {
    if (pipeline === null) {
      return null;
    } else if (Array.isArray(pipeline)) {
      return pipeline.map(value => this._parseAggregateArgs(schema, value));
    } else if (pipeline instanceof Date) {
      return pipeline;
    } else if (typeof pipeline === 'object') {
      const returnValue = {};

      for (const field in pipeline) {
        if (schema.fields[field] && schema.fields[field].type === 'Pointer') {
          if (typeof pipeline[field] === 'object') {
            // Pass objects down to MongoDB...this is more than likely an $exists operator.
            returnValue[`_p_${field}`] = pipeline[field];
          } else {
            returnValue[`_p_${field}`] = `${schema.fields[field].targetClass}$${pipeline[field]}`;
          }
        } else if (schema.fields[field] && schema.fields[field].type === 'Date') {
          returnValue[field] = this._convertToDate(pipeline[field]);
        } else if (pipeline[field] && pipeline[field].__type === "Date") {
          returnValue[field] = this._convertToDate(pipeline[field].iso);
        } else {
          returnValue[field] = this._parseAggregateArgs(schema, pipeline[field]);
        }

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

      return returnValue;
    }

    return pipeline;
  } // This function is slightly different than the one above. Rather than trying to combine these
  // two functions and making the code even harder to understand, I decided to split it up. The
  // difference with this function is we are not transforming the values, only the keys of the
  // pipeline.


  _parseAggregateProjectArgs(schema, pipeline) {
    const returnValue = {};

    for (const field in pipeline) {
      if (schema.fields[field] && schema.fields[field].type === 'Pointer') {
        returnValue[`_p_${field}`] = pipeline[field];
      } else {
        returnValue[field] = this._parseAggregateArgs(schema, pipeline[field]);
      }

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

    return returnValue;
  } // This function is slightly different than the two above. MongoDB $group aggregate looks like:
  //     { $group: { _id: <expression>, <field1>: { <accumulator1> : <expression1> }, ... } }
  // The <expression> could be a column name, prefixed with the '$' character. We'll look for
  // these <expression> and check to see if it is a 'Pointer' or if it's one of createdAt,
  // updatedAt or objectId and change it accordingly.


  _parseAggregateGroupArgs(schema, pipeline) {
    if (Array.isArray(pipeline)) {
      return pipeline.map(value => this._parseAggregateGroupArgs(schema, value));
    } else if (typeof pipeline === 'object') {
      const returnValue = {};

      for (const field in pipeline) {
        returnValue[field] = this._parseAggregateGroupArgs(schema, pipeline[field]);
      }

      return returnValue;
    } else if (typeof pipeline === 'string') {
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
  } // This function will attempt to convert the provided value to a Date object. Since this is part
  // of an aggregation pipeline, the value can either be a string or it can be another object with
  // an operator in it (like $gt, $lt, etc). Because of this I felt it was easier to make this a
  // recursive method to traverse down to the "leaf node" which is going to be the string.


  _convertToDate(value) {
    if (typeof value === 'string') {
      return new Date(value);
    }

    const returnValue = {};

    for (const field in value) {
      returnValue[field] = this._convertToDate(value[field]);
    }

    return returnValue;
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
    return transactionalSection.commitTransaction().then(() => {
      transactionalSection.endSession();
    });
  }

  abortTransactionalSession(transactionalSection) {
    return transactionalSection.abortTransaction().then(() => {
      transactionalSection.endSession();
    });
  }

}

exports.MongoStorageAdapter = MongoStorageAdapter;
var _default = MongoStorageAdapter;
exports.default = _default;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9BZGFwdGVycy9TdG9yYWdlL01vbmdvL01vbmdvU3RvcmFnZUFkYXB0ZXIuanMiXSwibmFtZXMiOlsibW9uZ29kYiIsInJlcXVpcmUiLCJNb25nb0NsaWVudCIsIlJlYWRQcmVmZXJlbmNlIiwiTW9uZ29TY2hlbWFDb2xsZWN0aW9uTmFtZSIsInN0b3JhZ2VBZGFwdGVyQWxsQ29sbGVjdGlvbnMiLCJtb25nb0FkYXB0ZXIiLCJjb25uZWN0IiwidGhlbiIsImRhdGFiYXNlIiwiY29sbGVjdGlvbnMiLCJmaWx0ZXIiLCJjb2xsZWN0aW9uIiwibmFtZXNwYWNlIiwibWF0Y2giLCJjb2xsZWN0aW9uTmFtZSIsImluZGV4T2YiLCJfY29sbGVjdGlvblByZWZpeCIsImNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEiLCJzY2hlbWEiLCJmaWVsZHMiLCJfcnBlcm0iLCJfd3Blcm0iLCJjbGFzc05hbWUiLCJfaGFzaGVkX3Bhc3N3b3JkIiwibW9uZ29TY2hlbWFGcm9tRmllbGRzQW5kQ2xhc3NOYW1lQW5kQ0xQIiwiY2xhc3NMZXZlbFBlcm1pc3Npb25zIiwiaW5kZXhlcyIsIm1vbmdvT2JqZWN0IiwiX2lkIiwib2JqZWN0SWQiLCJ1cGRhdGVkQXQiLCJjcmVhdGVkQXQiLCJfbWV0YWRhdGEiLCJ1bmRlZmluZWQiLCJmaWVsZE5hbWUiLCJ0eXBlIiwidGFyZ2V0Q2xhc3MiLCJmaWVsZE9wdGlvbnMiLCJNb25nb1NjaGVtYUNvbGxlY3Rpb24iLCJwYXJzZUZpZWxkVHlwZVRvTW9uZ29GaWVsZFR5cGUiLCJPYmplY3QiLCJrZXlzIiwibGVuZ3RoIiwiZmllbGRzX29wdGlvbnMiLCJjbGFzc19wZXJtaXNzaW9ucyIsIk1vbmdvU3RvcmFnZUFkYXB0ZXIiLCJjb25zdHJ1Y3RvciIsInVyaSIsImRlZmF1bHRzIiwiRGVmYXVsdE1vbmdvVVJJIiwiY29sbGVjdGlvblByZWZpeCIsIm1vbmdvT3B0aW9ucyIsIl91cmkiLCJfbW9uZ29PcHRpb25zIiwidXNlTmV3VXJsUGFyc2VyIiwidXNlVW5pZmllZFRvcG9sb2d5IiwiX29uY2hhbmdlIiwiX21heFRpbWVNUyIsIm1heFRpbWVNUyIsImNhblNvcnRPbkpvaW5UYWJsZXMiLCJ3YXRjaCIsImNhbGxiYWNrIiwiY29ubmVjdGlvblByb21pc2UiLCJlbmNvZGVkVXJpIiwiY2xpZW50Iiwib3B0aW9ucyIsInMiLCJkYiIsImRiTmFtZSIsIm9uIiwiY2F0Y2giLCJlcnIiLCJQcm9taXNlIiwicmVqZWN0IiwiaGFuZGxlRXJyb3IiLCJlcnJvciIsImNvZGUiLCJsb2dnZXIiLCJoYW5kbGVTaHV0ZG93biIsInJlc29sdmUiLCJjbG9zZSIsIl9hZGFwdGl2ZUNvbGxlY3Rpb24iLCJuYW1lIiwicmF3Q29sbGVjdGlvbiIsIk1vbmdvQ29sbGVjdGlvbiIsIl9zY2hlbWFDb2xsZWN0aW9uIiwiX3N0cmVhbSIsIl9tb25nb0NvbGxlY3Rpb24iLCJjbGFzc0V4aXN0cyIsImxpc3RDb2xsZWN0aW9ucyIsInRvQXJyYXkiLCJzZXRDbGFzc0xldmVsUGVybWlzc2lvbnMiLCJDTFBzIiwic2NoZW1hQ29sbGVjdGlvbiIsInVwZGF0ZVNjaGVtYSIsIiRzZXQiLCJzZXRJbmRleGVzV2l0aFNjaGVtYUZvcm1hdCIsInN1Ym1pdHRlZEluZGV4ZXMiLCJleGlzdGluZ0luZGV4ZXMiLCJfaWRfIiwiZGVsZXRlUHJvbWlzZXMiLCJpbnNlcnRlZEluZGV4ZXMiLCJmb3JFYWNoIiwiZmllbGQiLCJfX29wIiwiUGFyc2UiLCJFcnJvciIsIklOVkFMSURfUVVFUlkiLCJwcm9taXNlIiwiZHJvcEluZGV4IiwicHVzaCIsImtleSIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsImluc2VydFByb21pc2UiLCJjcmVhdGVJbmRleGVzIiwiYWxsIiwic2V0SW5kZXhlc0Zyb21Nb25nbyIsImdldEluZGV4ZXMiLCJyZWR1Y2UiLCJvYmoiLCJpbmRleCIsIl9mdHMiLCJfZnRzeCIsIndlaWdodHMiLCJjcmVhdGVDbGFzcyIsImluc2VydFNjaGVtYSIsImFkZEZpZWxkSWZOb3RFeGlzdHMiLCJjcmVhdGVJbmRleGVzSWZOZWVkZWQiLCJkZWxldGVDbGFzcyIsImRyb3AiLCJtZXNzYWdlIiwiZmluZEFuZERlbGV0ZVNjaGVtYSIsImRlbGV0ZUFsbENsYXNzZXMiLCJmYXN0IiwibWFwIiwiZGVsZXRlTWFueSIsImRlbGV0ZUZpZWxkcyIsImZpZWxkTmFtZXMiLCJtb25nb0Zvcm1hdE5hbWVzIiwiY29sbGVjdGlvblVwZGF0ZSIsIiR1bnNldCIsInNjaGVtYVVwZGF0ZSIsInVwZGF0ZU1hbnkiLCJnZXRBbGxDbGFzc2VzIiwic2NoZW1hc0NvbGxlY3Rpb24iLCJfZmV0Y2hBbGxTY2hlbWFzRnJvbV9TQ0hFTUEiLCJnZXRDbGFzcyIsIl9mZXRjaE9uZVNjaGVtYUZyb21fU0NIRU1BIiwiY3JlYXRlT2JqZWN0Iiwib2JqZWN0IiwidHJhbnNhY3Rpb25hbFNlc3Npb24iLCJpbnNlcnRPbmUiLCJEVVBMSUNBVEVfVkFMVUUiLCJ1bmRlcmx5aW5nRXJyb3IiLCJtYXRjaGVzIiwiQXJyYXkiLCJpc0FycmF5IiwidXNlckluZm8iLCJkdXBsaWNhdGVkX2ZpZWxkIiwiY3JlYXRlT2JqZWN0cyIsIm9iamVjdHMiLCJtb25nb09iamVjdHMiLCJpbnNlcnRNYW55IiwiZGVsZXRlT2JqZWN0c0J5UXVlcnkiLCJxdWVyeSIsIm1vbmdvV2hlcmUiLCJyZXN1bHQiLCJuIiwiT0JKRUNUX05PVF9GT1VORCIsIklOVEVSTkFMX1NFUlZFUl9FUlJPUiIsInVwZGF0ZU9iamVjdHNCeVF1ZXJ5IiwidXBkYXRlIiwibW9uZ29VcGRhdGUiLCJmaW5kT25lQW5kVXBkYXRlIiwicmV0dXJuT3JpZ2luYWwiLCJzZXNzaW9uIiwidmFsdWUiLCJ1cGRhdGVPYmplY3RzQnlCdWxrIiwib3BlcmF0aW9ucyIsImJ1bGtzIiwidXBkYXRlT25lIiwidXBzZXJ0IiwiZG9jdW1lbnQiLCJidWxrV3JpdGUiLCJ1cHNlcnRPbmVPYmplY3QiLCJ1cHNlcnRPbmUiLCJmaW5kIiwic2tpcCIsImxpbWl0Iiwic29ydCIsInJlYWRQcmVmZXJlbmNlIiwiaGludCIsImNhc2VJbnNlbnNpdGl2ZSIsImV4cGxhaW4iLCJtb25nb1NvcnQiLCJfIiwibWFwS2V5cyIsIm1vbmdvS2V5cyIsIm1lbW8iLCJfcGFyc2VSZWFkUHJlZmVyZW5jZSIsImNyZWF0ZVRleHRJbmRleGVzSWZOZWVkZWQiLCJlbnN1cmVJbmRleCIsImluZGV4TmFtZSIsImluZGV4Q3JlYXRpb25SZXF1ZXN0IiwibW9uZ29GaWVsZE5hbWVzIiwiaW5kZXhUeXBlIiwiZGVmYXVsdE9wdGlvbnMiLCJiYWNrZ3JvdW5kIiwic3BhcnNlIiwiaW5kZXhOYW1lT3B0aW9ucyIsInR0bE9wdGlvbnMiLCJ0dGwiLCJleHBpcmVBZnRlclNlY29uZHMiLCJjYXNlSW5zZW5zaXRpdmVPcHRpb25zIiwiY29sbGF0aW9uIiwiY2FzZUluc2Vuc2l0aXZlQ29sbGF0aW9uIiwiaW5kZXhPcHRpb25zIiwiY3JlYXRlSW5kZXgiLCJlbnN1cmVVbmlxdWVuZXNzIiwiX2Vuc3VyZVNwYXJzZVVuaXF1ZUluZGV4SW5CYWNrZ3JvdW5kIiwiX3Jhd0ZpbmQiLCJjb3VudCIsImRpc3RpbmN0IiwiaXNQb2ludGVyRmllbGQiLCJ0cmFuc2Zvcm1GaWVsZCIsImFnZ3JlZ2F0ZSIsInBpcGVsaW5lIiwic3RhZ2UiLCIkZ3JvdXAiLCJfcGFyc2VBZ2dyZWdhdGVHcm91cEFyZ3MiLCIkbWF0Y2giLCJfcGFyc2VBZ2dyZWdhdGVBcmdzIiwiJHByb2plY3QiLCJfcGFyc2VBZ2dyZWdhdGVQcm9qZWN0QXJncyIsIiRnZW9OZWFyIiwicmVzdWx0cyIsInNwbGl0IiwiaW5jbHVkZXMiLCJpc0VtcHR5IiwiRGF0ZSIsInJldHVyblZhbHVlIiwiX2NvbnZlcnRUb0RhdGUiLCJfX3R5cGUiLCJpc28iLCJzdWJzdHJpbmciLCJ0b1VwcGVyQ2FzZSIsIlBSSU1BUlkiLCJQUklNQVJZX1BSRUZFUlJFRCIsIlNFQ09OREFSWSIsIlNFQ09OREFSWV9QUkVGRVJSRUQiLCJORUFSRVNUIiwicGVyZm9ybUluaXRpYWxpemF0aW9uIiwiJHRleHQiLCJ0ZXh0SW5kZXgiLCJkcm9wQWxsSW5kZXhlcyIsImRyb3BJbmRleGVzIiwidXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMiLCJjbGFzc2VzIiwicHJvbWlzZXMiLCJjcmVhdGVUcmFuc2FjdGlvbmFsU2Vzc2lvbiIsInRyYW5zYWN0aW9uYWxTZWN0aW9uIiwic3RhcnRTZXNzaW9uIiwic3RhcnRUcmFuc2FjdGlvbiIsImNvbW1pdFRyYW5zYWN0aW9uYWxTZXNzaW9uIiwiY29tbWl0VHJhbnNhY3Rpb24iLCJlbmRTZXNzaW9uIiwiYWJvcnRUcmFuc2FjdGlvbmFsU2Vzc2lvbiIsImFib3J0VHJhbnNhY3Rpb24iXSwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFDQTs7QUFDQTs7QUFDQTs7QUFPQTs7QUFJQTs7QUFTQTs7QUFFQTs7QUFDQTs7QUFDQTs7Ozs7Ozs7Ozs7Ozs7OztBQUVBO0FBQ0EsTUFBTUEsT0FBTyxHQUFHQyxPQUFPLENBQUMsU0FBRCxDQUF2Qjs7QUFDQSxNQUFNQyxXQUFXLEdBQUdGLE9BQU8sQ0FBQ0UsV0FBNUI7QUFDQSxNQUFNQyxjQUFjLEdBQUdILE9BQU8sQ0FBQ0csY0FBL0I7QUFFQSxNQUFNQyx5QkFBeUIsR0FBRyxTQUFsQzs7QUFFQSxNQUFNQyw0QkFBNEIsR0FBSUMsWUFBRCxJQUFrQjtBQUNyRCxTQUFPQSxZQUFZLENBQ2hCQyxPQURJLEdBRUpDLElBRkksQ0FFQyxNQUFNRixZQUFZLENBQUNHLFFBQWIsQ0FBc0JDLFdBQXRCLEVBRlAsRUFHSkYsSUFISSxDQUdFRSxXQUFELElBQWlCO0FBQ3JCLFdBQU9BLFdBQVcsQ0FBQ0MsTUFBWixDQUFvQkMsVUFBRCxJQUFnQjtBQUN4QyxVQUFJQSxVQUFVLENBQUNDLFNBQVgsQ0FBcUJDLEtBQXJCLENBQTJCLFlBQTNCLENBQUosRUFBOEM7QUFDNUMsZUFBTyxLQUFQO0FBQ0QsT0FIdUMsQ0FJeEM7QUFDQTs7O0FBQ0EsYUFDRUYsVUFBVSxDQUFDRyxjQUFYLENBQTBCQyxP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TCxvQkFBaEIsQ0FBUDtBQUNEOztBQUVERyxFQUFBQSwwQkFBMEIsQ0FBQ0gsb0JBQUQsRUFBMkM7QUFDbkUsV0FBT0Esb0JBQW9CLENBQUNJLGlCQUFyQixHQUF5Q25RLElBQXpDLENBQThDLE1BQU07QUFDekQrUCxNQUFBQSxvQkFBb0IsQ0FBQ0ssVUFBckI7QUFDRCxLQUZNLENBQVA7QUFHRDs7QUFFREMsRUFBQUEseUJBQXlCLENBQUNOLG9CQUFELEVBQTJDO0FBQ2xFLFdBQU9BLG9CQUFvQixDQUFDTyxnQkFBckIsR0FBd0N0USxJQUF4QyxDQUE2QyxNQUFNO0FBQ3hEK1AsTUFBQUEsb0JBQW9CLENBQUNLLFVBQXJCO0FBQ0QsS0FGTSxDQUFQO0FBR0Q7O0FBbm9Dd0Q7OztlQXNvQzVDOU4sbUIiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBAZmxvd1xuaW1wb3J0IE1vbmdvQ29sbGVjdGlvbiBmcm9tICcuL01vbmdvQ29sbGVjdGlvbic7XG5pbXBvcnQgTW9uZ29TY2hlbWFDb2xsZWN0aW9uIGZyb20gJy4vTW9uZ29TY2hlbWFDb2xsZWN0aW9uJztcbmltcG9ydCB7IFN0b3JhZ2VBZGFwdGVyIH0gZnJvbSAnLi4vU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IHR5cGUge1xuICBTY2hlbWFUeXBlLFxuICBRdWVyeVR5cGUsXG4gIFN0b3JhZ2VDbGFzcyxcbiAgUXVlcnlPcHRpb25zLFxufSBmcm9tICcuLi9TdG9yYWdlQWRhcHRlcic7XG5pbXBvcnQge1xuICBwYXJzZSBhcyBwYXJzZVVybCxcbiAgZm9ybWF0IGFzIGZvcm1hdFVybCxcbn0gZnJvbSAnLi4vLi4vLi4vdmVuZG9yL21vbmdvZGJVcmwnO1xuaW1wb3J0IHtcbiAgcGFyc2VPYmplY3RUb01vbmdvT2JqZWN0Rm9yQ3JlYXRlLFxuICBtb25nb09iamVjdFRvUGFyc2VPYmplY3QsXG4gIHRyYW5zZm9ybUtleSxcbiAgdHJhbnNmb3JtV2hlcmUsXG4gIHRyYW5zZm9ybVVwZGF0ZSxcbiAgdHJhbnNmb3JtUG9pbnRlclN0cmluZyxcbn0gZnJvbSAnLi9Nb25nb1RyYW5zZm9ybSc7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCBQYXJzZSBmcm9tICdwYXJzZS9ub2RlJztcbi8vIEBmbG93LWRpc2FibGUtbmV4dFxuaW1wb3J0IF8gZnJvbSAnbG9kYXNoJztcbmltcG9ydCBkZWZhdWx0cyBmcm9tICcuLi8uLi8uLi9kZWZhdWx0cyc7XG5pbXBvcnQgbG9nZ2VyIGZyb20gJy4uLy4uLy4uL2xvZ2dlcic7XG5cbi8vIEBmbG93LWRpc2FibGUtbmV4dFxuY29uc3QgbW9uZ29kYiA9IHJlcXVpcmUoJ21vbmdvZGInKTtcbmNvbnN0IE1vbmdvQ2xpZW50ID0gbW9uZ29kYi5Nb25nb0NsaWVudDtcbmNvbnN0IFJlYWRQcmVmZXJlbmNlID0gbW9uZ29kYi5SZWFkUHJlZmVyZW5jZTtcblxuY29uc3QgTW9uZ29TY2hlbWFDb2xsZWN0aW9uTmFtZSA9ICdfU0NIRU1BJztcblxuY29uc3Qgc3RvcmFnZUFkYXB0ZXJBbGxDb2xsZWN0aW9ucyA9IChtb25nb0FkYXB0ZXIpID0+IHtcbiAgcmV0dXJuIG1vbmdvQWRhcHRlclxuICAgIC5jb25uZWN0KClcbiAgICAudGhlbigoKSA9PiBtb25nb0FkYXB0ZXIuZGF0YWJhc2UuY29sbGVjdGlvbnMoKSlcbiAgICAudGhlbigoY29sbGVjdGlvbnMpID0+IHtcbiAgICAgIHJldHVybiBjb2xsZWN0aW9ucy5maWx0ZXIoKGNvbGxlY3Rpb24pID0+IHtcbiAgICAgICAgaWYgKGNvbGxlY3Rpb24ubmFtZXNwYWNlLm1hdGNoKC9cXC5zeXN0ZW1cXC4vKSkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICAvLyBUT0RPOiBJZiB5b3UgaGF2ZSBvbmUgYXBwIHdpdGggYSBjb2xsZWN0aW9uIHByZWZpeCB0aGF0IGhhcHBlbnMgdG8gYmUgYSBwcmVmaXggb2YgYW5vdGhlclxuICAgICAgICAvLyBhcHBzIHByZWZpeCwgdGhpcyB3aWxsIGdvIHZlcnkgdmVyeSBiYWRseS4gV2Ugc2hvdWxkIGZpeCB0aGF0IHNvbWVob3cuXG4gICAgICAgIHJldHVybiAoXG4gICAgICAgICAgY29sbGVjdGlvbi5jb2xsZWN0aW9uTmFtZS5pbmRleE9mKG1vbmdvQWRhcHRlci5fY29sbGVjdGlvblByZWZpeCkgPT0gMFxuICAgICAgICApO1xuICAgICAgfSk7XG4gICAgfSk7XG59O1xuXG5jb25zdCBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hID0gKHsgLi4uc2NoZW1hIH0pID0+IHtcbiAgZGVsZXRlIHNjaGVtYS5maWVsZHMuX3JwZXJtO1xuICBkZWxldGUgc2NoZW1hLmZpZWxkcy5fd3Blcm07XG5cbiAgaWYgKHNjaGVtYS5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICAvLyBMZWdhY3kgbW9uZ28gYWRhcHRlciBrbm93cyBhYm91dCB0aGUgZGlmZmVyZW5jZSBiZXR3ZWVuIHBhc3N3b3JkIGFuZCBfaGFzaGVkX3Bhc3N3b3JkLlxuICAgIC8vIEZ1dHVyZSBkYXRhYmFzZSBhZGFwdGVycyB3aWxsIG9ubHkga25vdyBhYm91dCBfaGFzaGVkX3Bhc3N3b3JkLlxuICAgIC8vIE5vdGU6IFBhcnNlIFNlcnZlciB3aWxsIGJyaW5nIGJhY2sgcGFzc3dvcmQgd2l0aCBpbmplY3REZWZhdWx0U2NoZW1hLCBzbyB3ZSBkb24ndCBuZWVkXG4gICAgLy8gdG8gYWRkIF9oYXNoZWRfcGFzc3dvcmQgYmFjayBldmVyLlxuICAgIGRlbGV0ZSBzY2hlbWEuZmllbGRzLl9oYXNoZWRfcGFzc3dvcmQ7XG4gIH1cblxuICByZXR1cm4gc2NoZW1hO1xufTtcblxuLy8gUmV0dXJucyB7IGNvZGUsIGVycm9yIH0gaWYgaW52YWxpZCwgb3IgeyByZXN1bHQgfSwgYW4gb2JqZWN0XG4vLyBzdWl0YWJsZSBmb3IgaW5zZXJ0aW5nIGludG8gX1NDSEVNQSBjb2xsZWN0aW9uLCBvdGhlcndpc2UuXG5jb25zdCBtb25nb1NjaGVtYUZyb21GaWVsZHNBbmRDbGFzc05hbWVBbmRDTFAgPSAoXG4gIGZpZWxkcyxcbiAgY2xhc3NOYW1lLFxuICBjbGFzc0xldmVsUGVybWlzc2lvbnMsXG4gIGluZGV4ZXNcbikgPT4ge1xuICBjb25zdCBtb25nb09iamVjdCA9IHtcbiAgICBfaWQ6IGNsYXNzTmFtZSxcbiAgICBvYmplY3RJZDogJ3N0cmluZycsXG4gICAgdXBkYXRlZEF0OiAnc3RyaW5nJyxcbiAgICBjcmVhdGVkQXQ6ICdzdHJpbmcnLFxuICAgIF9tZXRhZGF0YTogdW5kZWZpbmVkLFxuICB9O1xuXG4gIGZvciAoY29uc3QgZmllbGROYW1lIGluIGZpZWxkcykge1xuICAgIGNvbnN0IHsgdHlwZSwgdGFyZ2V0Q2xhc3MsIC4uLmZpZWxkT3B0aW9ucyB9ID0gZmllbGRzW2ZpZWxkTmFtZV07XG4gICAgbW9uZ29PYmplY3RbXG4gICAgICBmaWVsZE5hbWVcbiAgICBdID0gTW9uZ29TY2hlbWFDb2xsZWN0aW9uLnBhcnNlRmllbGRUeXBlVG9Nb25nb0ZpZWxkVHlwZSh7XG4gICAgICB0eXBlLFxuICAgICAgdGFyZ2V0Q2xhc3MsXG4gICAgfSk7XG4gICAgaWYgKGZpZWxkT3B0aW9ucyAmJiBPYmplY3Qua2V5cyhmaWVsZE9wdGlvbnMpLmxlbmd0aCA+IDApIHtcbiAgICAgIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YSA9IG1vbmdvT2JqZWN0Ll9tZXRhZGF0YSB8fCB7fTtcbiAgICAgIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YS5maWVsZHNfb3B0aW9ucyA9XG4gICAgICAgIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YS5maWVsZHNfb3B0aW9ucyB8fCB7fTtcbiAgICAgIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YS5maWVsZHNfb3B0aW9uc1tmaWVsZE5hbWVdID0gZmllbGRPcHRpb25zO1xuICAgIH1cbiAgfVxuXG4gIGlmICh0eXBlb2YgY2xhc3NMZXZlbFBlcm1pc3Npb25zICE9PSAndW5kZWZpbmVkJykge1xuICAgIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YSA9IG1vbmdvT2JqZWN0Ll9tZXRhZGF0YSB8fCB7fTtcbiAgICBpZiAoIWNsYXNzTGV2ZWxQZXJtaXNzaW9ucykge1xuICAgICAgZGVsZXRlIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YS5jbGFzc19wZXJtaXNzaW9ucztcbiAgICB9IGVsc2Uge1xuICAgICAgbW9uZ29PYmplY3QuX21ldGFkYXRhLmNsYXNzX3Blcm1pc3Npb25zID0gY2xhc3NMZXZlbFBlcm1pc3Npb25zO1xuICAgIH1cbiAgfVxuXG4gIGlmIChcbiAgICBpbmRleGVzICYmXG4gICAgdHlwZW9mIGluZGV4ZXMgPT09ICdvYmplY3QnICYmXG4gICAgT2JqZWN0LmtleXMoaW5kZXhlcykubGVuZ3RoID4gMFxuICApIHtcbiAgICBtb25nb09iamVjdC5fbWV0YWRhdGEgPSBtb25nb09iamVjdC5fbWV0YWRhdGEgfHwge307XG4gICAgbW9uZ29PYmplY3QuX21ldGFkYXRhLmluZGV4ZXMgPSBpbmRleGVzO1xuICB9XG5cbiAgaWYgKCFtb25nb09iamVjdC5fbWV0YWRhdGEpIHtcbiAgICAvLyBjbGVhbnVwIHRoZSB1bnVzZWQgX21ldGFkYXRhXG4gICAgZGVsZXRlIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YTtcbiAgfVxuXG4gIHJldHVybiBtb25nb09iamVjdDtcbn07XG5cbmV4cG9ydCBjbGFzcyBNb25nb1N0b3JhZ2VBZGFwdGVyIGltcGxlbWVudHMgU3RvcmFnZUFkYXB0ZXIge1xuICAvLyBQcml2YXRlXG4gIF91cmk6IHN0cmluZztcbiAgX2NvbGxlY3Rpb25QcmVmaXg6IHN0cmluZztcbiAgX21vbmdvT3B0aW9uczogT2JqZWN0O1xuICBfc3RyZWFtOiBhbnk7XG4gIF9vbmNoYW5nZTogYW55O1xuICAvLyBQdWJsaWNcbiAgY29ubmVjdGlvblByb21pc2U6ID9Qcm9taXNlPGFueT47XG4gIGRhdGFiYXNlOiBhbnk7XG4gIGNsaWVudDogTW9uZ29DbGllbnQ7XG4gIF9tYXhUaW1lTVM6ID9udW1iZXI7XG4gIGNhblNvcnRPbkpvaW5UYWJsZXM6IGJvb2xlYW47XG5cbiAgY29uc3RydWN0b3Ioe1xuICAgIHVyaSA9IGRlZmF1bHRzLkRlZmF1bHRNb25nb1VSSSxcbiAgICBjb2xsZWN0aW9uUHJlZml4ID0gJycsXG4gICAgbW9uZ29PcHRpb25zID0ge30sXG4gIH06IGFueSkge1xuICAgIHRoaXMuX3VyaSA9IHVyaTtcbiAgICB0aGlzLl9jb2xsZWN0aW9uUHJlZml4ID0gY29sbGVjdGlvblByZWZpeDtcbiAgICB0aGlzLl9tb25nb09wdGlvbnMgPSBtb25nb09wdGlvbnM7XG4gICAgdGhpcy5fbW9uZ29PcHRpb25zLnVzZU5ld1VybFBhcnNlciA9IHRydWU7XG4gICAgdGhpcy5fbW9uZ29PcHRpb25zLnVzZVVuaWZpZWRUb3BvbG9neSA9IHRydWU7XG4gICAgdGhpcy5fb25jaGFuZ2UgPSAoKSA9PiB7fTtcblxuICAgIC8vIE1heFRpbWVNUyBpcyBub3QgYSBnbG9iYWwgTW9uZ29EQiBjbGllbnQgb3B0aW9uLCBpdCBpcyBhcHBsaWVkIHBlciBvcGVyYXRpb24uXG4gICAgdGhpcy5fbWF4VGltZU1TID0gbW9uZ29PcHRpb25zLm1heFRpbWVNUztcbiAgICB0aGlzLmNhblNvcnRPbkpvaW5UYWJsZXMgPSB0cnVlO1xuICAgIGRlbGV0ZSBtb25nb09wdGlvbnMubWF4VGltZU1TO1xuICB9XG5cbiAgd2F0Y2goY2FsbGJhY2spIHtcbiAgICB0aGlzLl9vbmNoYW5nZSA9IGNhbGxiYWNrO1xuICB9XG5cbiAgY29ubmVjdCgpIHtcbiAgICBpZiAodGhpcy5jb25uZWN0aW9uUHJvbWlzZSkge1xuICAgICAgcmV0dXJuIHRoaXMuY29ubmVjdGlvblByb21pc2U7XG4gICAgfVxuXG4gICAgLy8gcGFyc2luZyBhbmQgcmUtZm9ybWF0dGluZyBjYXVzZXMgdGhlIGF1dGggdmFsdWUgKGlmIHRoZXJlKSB0byBnZXQgVVJJXG4gICAgLy8gZW5jb2RlZFxuICAgIGNvbnN0IGVuY29kZWRVcmkgPSBmb3JtYXRVcmwocGFyc2VVcmwodGhpcy5fdXJpKSk7XG5cbiAgICB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlID0gTW9uZ29DbGllbnQuY29ubmVjdChlbmNvZGVkVXJpLCB0aGlzLl9tb25nb09wdGlvbnMpXG4gICAgICAudGhlbigoY2xpZW50KSA9PiB7XG4gICAgICAgIC8vIFN0YXJ0aW5nIG1vbmdvREIgMy4wLCB0aGUgTW9uZ29DbGllbnQuY29ubmVjdCBkb24ndCByZXR1cm4gYSBEQiBhbnltb3JlIGJ1dCBhIGNsaWVudFxuICAgICAgICAvLyBGb3J0dW5hdGVseSwgd2UgY2FuIGdldCBiYWNrIHRoZSBvcHRpb25zIGFuZCB1c2UgdGhlbSB0byBzZWxlY3QgdGhlIHByb3BlciBEQi5cbiAgICAgICAgLy8gaHR0cHM6Ly9naXRodWIuY29tL21vbmdvZGIvbm9kZS1tb25nb2RiLW5hdGl2ZS9ibG9iLzJjMzVkNzZmMDg1NzQyMjViOGRiMDJkN2JlZjY4NzEyM2U2YmIwMTgvbGliL21vbmdvX2NsaWVudC5qcyNMODg1XG4gICAgICAgIGNvbnN0IG9wdGlvbnMgPSBjbGllbnQucy5vcHRpb25zO1xuICAgICAgICBjb25zdCBkYXRhYmFzZSA9IGNsaWVudC5kYihvcHRpb25zLmRiTmFtZSk7XG4gICAgICAgIGlmICghZGF0YWJhc2UpIHtcbiAgICAgICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgZGF0YWJhc2Uub24oJ2Vycm9yJywgKCkgPT4ge1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgICAgICB9KTtcbiAgICAgICAgZGF0YWJhc2Uub24oJ2Nsb3NlJywgKCkgPT4ge1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgICAgICB9KTtcbiAgICAgICAgdGhpcy5jbGllbnQgPSBjbGllbnQ7XG4gICAgICAgIHRoaXMuZGF0YWJhc2UgPSBkYXRhYmFzZTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goKGVycikgPT4ge1xuICAgICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KGVycik7XG4gICAgICB9KTtcblxuICAgIHJldHVybiB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICB9XG5cbiAgaGFuZGxlRXJyb3I8VD4oZXJyb3I6ID8oRXJyb3IgfCBQYXJzZS5FcnJvcikpOiBQcm9taXNlPFQ+IHtcbiAgICBpZiAoZXJyb3IgJiYgZXJyb3IuY29kZSA9PT0gMTMpIHtcbiAgICAgIC8vIFVuYXV0aG9yaXplZCBlcnJvclxuICAgICAgZGVsZXRlIHRoaXMuY2xpZW50O1xuICAgICAgZGVsZXRlIHRoaXMuZGF0YWJhc2U7XG4gICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgIGxvZ2dlci5lcnJvcignUmVjZWl2ZWQgdW5hdXRob3JpemVkIGVycm9yJywgeyBlcnJvcjogZXJyb3IgfSk7XG4gICAgfVxuICAgIHRocm93IGVycm9yO1xuICB9XG5cbiAgaGFuZGxlU2h1dGRvd24oKSB7XG4gICAgaWYgKCF0aGlzLmNsaWVudCkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5jbGllbnQuY2xvc2UoZmFsc2UpO1xuICB9XG5cbiAgX2FkYXB0aXZlQ29sbGVjdGlvbihuYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5jb25uZWN0KClcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuZGF0YWJhc2UuY29sbGVjdGlvbih0aGlzLl9jb2xsZWN0aW9uUHJlZml4ICsgbmFtZSkpXG4gICAgICAudGhlbigocmF3Q29sbGVjdGlvbikgPT4gbmV3IE1vbmdvQ29sbGVjdGlvbihyYXdDb2xsZWN0aW9uKSlcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgX3NjaGVtYUNvbGxlY3Rpb24oKTogUHJvbWlzZTxNb25nb1NjaGVtYUNvbGxlY3Rpb24+IHtcbiAgICByZXR1cm4gdGhpcy5jb25uZWN0KClcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihNb25nb1NjaGVtYUNvbGxlY3Rpb25OYW1lKSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4ge1xuICAgICAgICBpZiAoIXRoaXMuX3N0cmVhbSkge1xuICAgICAgICAgIHRoaXMuX3N0cmVhbSA9IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi53YXRjaCgpO1xuICAgICAgICAgIHRoaXMuX3N0cmVhbS5vbignY2hhbmdlJywgdGhpcy5fb25jaGFuZ2UpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBuZXcgTW9uZ29TY2hlbWFDb2xsZWN0aW9uKGNvbGxlY3Rpb24pO1xuICAgICAgfSk7XG4gIH1cblxuICBjbGFzc0V4aXN0cyhuYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5jb25uZWN0KClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGF0YWJhc2VcbiAgICAgICAgICAubGlzdENvbGxlY3Rpb25zKHsgbmFtZTogdGhpcy5fY29sbGVjdGlvblByZWZpeCArIG5hbWUgfSlcbiAgICAgICAgICAudG9BcnJheSgpO1xuICAgICAgfSlcbiAgICAgIC50aGVuKChjb2xsZWN0aW9ucykgPT4ge1xuICAgICAgICByZXR1cm4gY29sbGVjdGlvbnMubGVuZ3RoID4gMDtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goKGVycikgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIHNldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyhjbGFzc05hbWU6IHN0cmluZywgQ0xQczogYW55KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKVxuICAgICAgLnRoZW4oKHNjaGVtYUNvbGxlY3Rpb24pID0+XG4gICAgICAgIHNjaGVtYUNvbGxlY3Rpb24udXBkYXRlU2NoZW1hKGNsYXNzTmFtZSwge1xuICAgICAgICAgICRzZXQ6IHsgJ19tZXRhZGF0YS5jbGFzc19wZXJtaXNzaW9ucyc6IENMUHMgfSxcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgc2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc3VibWl0dGVkSW5kZXhlczogYW55LFxuICAgIGV4aXN0aW5nSW5kZXhlczogYW55ID0ge30sXG4gICAgZmllbGRzOiBhbnlcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHN1Ym1pdHRlZEluZGV4ZXMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIH1cbiAgICBpZiAoT2JqZWN0LmtleXMoZXhpc3RpbmdJbmRleGVzKS5sZW5ndGggPT09IDApIHtcbiAgICAgIGV4aXN0aW5nSW5kZXhlcyA9IHsgX2lkXzogeyBfaWQ6IDEgfSB9O1xuICAgIH1cbiAgICBjb25zdCBkZWxldGVQcm9taXNlcyA9IFtdO1xuICAgIGNvbnN0IGluc2VydGVkSW5kZXhlcyA9IFtdO1xuICAgIE9iamVjdC5rZXlzKHN1Ym1pdHRlZEluZGV4ZXMpLmZvckVhY2goKG5hbWUpID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkID0gc3VibWl0dGVkSW5kZXhlc1tuYW1lXTtcbiAgICAgIGlmIChleGlzdGluZ0luZGV4ZXNbbmFtZV0gJiYgZmllbGQuX19vcCAhPT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICAgYEluZGV4ICR7bmFtZX0gZXhpc3RzLCBjYW5ub3QgdXBkYXRlLmBcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICghZXhpc3RpbmdJbmRleGVzW25hbWVdICYmIGZpZWxkLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgIGBJbmRleCAke25hbWV9IGRvZXMgbm90IGV4aXN0LCBjYW5ub3QgZGVsZXRlLmBcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChmaWVsZC5fX29wID09PSAnRGVsZXRlJykge1xuICAgICAgICBjb25zdCBwcm9taXNlID0gdGhpcy5kcm9wSW5kZXgoY2xhc3NOYW1lLCBuYW1lKTtcbiAgICAgICAgZGVsZXRlUHJvbWlzZXMucHVzaChwcm9taXNlKTtcbiAgICAgICAgZGVsZXRlIGV4aXN0aW5nSW5kZXhlc1tuYW1lXTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIE9iamVjdC5rZXlzKGZpZWxkKS5mb3JFYWNoKChrZXkpID0+IHtcbiAgICAgICAgICBpZiAoIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChmaWVsZHMsIGtleSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICAgICAgICAgYEZpZWxkICR7a2V5fSBkb2VzIG5vdCBleGlzdCwgY2Fubm90IGFkZCBpbmRleC5gXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIGV4aXN0aW5nSW5kZXhlc1tuYW1lXSA9IGZpZWxkO1xuICAgICAgICBpbnNlcnRlZEluZGV4ZXMucHVzaCh7XG4gICAgICAgICAga2V5OiBmaWVsZCxcbiAgICAgICAgICBuYW1lLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBsZXQgaW5zZXJ0UHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSgpO1xuICAgIGlmIChpbnNlcnRlZEluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgaW5zZXJ0UHJvbWlzZSA9IHRoaXMuY3JlYXRlSW5kZXhlcyhjbGFzc05hbWUsIGluc2VydGVkSW5kZXhlcyk7XG4gICAgfVxuICAgIHJldHVybiBQcm9taXNlLmFsbChkZWxldGVQcm9taXNlcylcbiAgICAgIC50aGVuKCgpID0+IGluc2VydFByb21pc2UpXG4gICAgICAudGhlbigoKSA9PiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKCkpXG4gICAgICAudGhlbigoc2NoZW1hQ29sbGVjdGlvbikgPT5cbiAgICAgICAgc2NoZW1hQ29sbGVjdGlvbi51cGRhdGVTY2hlbWEoY2xhc3NOYW1lLCB7XG4gICAgICAgICAgJHNldDogeyAnX21ldGFkYXRhLmluZGV4ZXMnOiBleGlzdGluZ0luZGV4ZXMgfSxcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgc2V0SW5kZXhlc0Zyb21Nb25nbyhjbGFzc05hbWU6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLmdldEluZGV4ZXMoY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oKGluZGV4ZXMpID0+IHtcbiAgICAgICAgaW5kZXhlcyA9IGluZGV4ZXMucmVkdWNlKChvYmosIGluZGV4KSA9PiB7XG4gICAgICAgICAgaWYgKGluZGV4LmtleS5fZnRzKSB7XG4gICAgICAgICAgICBkZWxldGUgaW5kZXgua2V5Ll9mdHM7XG4gICAgICAgICAgICBkZWxldGUgaW5kZXgua2V5Ll9mdHN4O1xuICAgICAgICAgICAgZm9yIChjb25zdCBmaWVsZCBpbiBpbmRleC53ZWlnaHRzKSB7XG4gICAgICAgICAgICAgIGluZGV4LmtleVtmaWVsZF0gPSAndGV4dCc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIG9ialtpbmRleC5uYW1lXSA9IGluZGV4LmtleTtcbiAgICAgICAgICByZXR1cm4gb2JqO1xuICAgICAgICB9LCB7fSk7XG4gICAgICAgIHJldHVybiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKCkudGhlbigoc2NoZW1hQ29sbGVjdGlvbikgPT5cbiAgICAgICAgICBzY2hlbWFDb2xsZWN0aW9uLnVwZGF0ZVNjaGVtYShjbGFzc05hbWUsIHtcbiAgICAgICAgICAgICRzZXQ6IHsgJ19tZXRhZGF0YS5pbmRleGVzJzogaW5kZXhlcyB9LFxuICAgICAgICAgIH0pXG4gICAgICAgICk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnIpID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSlcbiAgICAgIC5jYXRjaCgoKSA9PiB7XG4gICAgICAgIC8vIElnbm9yZSBpZiBjb2xsZWN0aW9uIG5vdCBmb3VuZFxuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICB9KTtcbiAgfVxuXG4gIGNyZWF0ZUNsYXNzKGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29PYmplY3QgPSBtb25nb1NjaGVtYUZyb21GaWVsZHNBbmRDbGFzc05hbWVBbmRDTFAoXG4gICAgICBzY2hlbWEuZmllbGRzLFxuICAgICAgY2xhc3NOYW1lLFxuICAgICAgc2NoZW1hLmNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgIHNjaGVtYS5pbmRleGVzXG4gICAgKTtcbiAgICBtb25nb09iamVjdC5faWQgPSBjbGFzc05hbWU7XG4gICAgcmV0dXJuIHRoaXMuc2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQoXG4gICAgICBjbGFzc05hbWUsXG4gICAgICBzY2hlbWEuaW5kZXhlcyxcbiAgICAgIHt9LFxuICAgICAgc2NoZW1hLmZpZWxkc1xuICAgIClcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKSlcbiAgICAgIC50aGVuKChzY2hlbWFDb2xsZWN0aW9uKSA9PiBzY2hlbWFDb2xsZWN0aW9uLmluc2VydFNjaGVtYShtb25nb09iamVjdCkpXG4gICAgICAuY2F0Y2goKGVycikgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGFkZEZpZWxkSWZOb3RFeGlzdHMoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgZmllbGROYW1lOiBzdHJpbmcsXG4gICAgdHlwZTogYW55XG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKClcbiAgICAgIC50aGVuKChzY2hlbWFDb2xsZWN0aW9uKSA9PlxuICAgICAgICBzY2hlbWFDb2xsZWN0aW9uLmFkZEZpZWxkSWZOb3RFeGlzdHMoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHR5cGUpXG4gICAgICApXG4gICAgICAudGhlbigoKSA9PiB0aGlzLmNyZWF0ZUluZGV4ZXNJZk5lZWRlZChjbGFzc05hbWUsIGZpZWxkTmFtZSwgdHlwZSkpXG4gICAgICAuY2F0Y2goKGVycikgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIERyb3BzIGEgY29sbGVjdGlvbi4gUmVzb2x2ZXMgd2l0aCB0cnVlIGlmIGl0IHdhcyBhIFBhcnNlIFNjaGVtYSAoZWcuIF9Vc2VyLCBDdXN0b20sIGV0Yy4pXG4gIC8vIGFuZCByZXNvbHZlcyB3aXRoIGZhbHNlIGlmIGl0IHdhc24ndCAoZWcuIGEgam9pbiB0YWJsZSkuIFJlamVjdHMgaWYgZGVsZXRpb24gd2FzIGltcG9zc2libGUuXG4gIGRlbGV0ZUNsYXNzKGNsYXNzTmFtZTogc3RyaW5nKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAgIC50aGVuKChjb2xsZWN0aW9uKSA9PiBjb2xsZWN0aW9uLmRyb3AoKSlcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICAgIC8vICducyBub3QgZm91bmQnIG1lYW5zIGNvbGxlY3Rpb24gd2FzIGFscmVhZHkgZ29uZS4gSWdub3JlIGRlbGV0aW9uIGF0dGVtcHQuXG4gICAgICAgICAgaWYgKGVycm9yLm1lc3NhZ2UgPT0gJ25zIG5vdCBmb3VuZCcpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH0pXG4gICAgICAgIC8vIFdlJ3ZlIGRyb3BwZWQgdGhlIGNvbGxlY3Rpb24sIG5vdyByZW1vdmUgdGhlIF9TQ0hFTUEgZG9jdW1lbnRcbiAgICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpKVxuICAgICAgICAudGhlbigoc2NoZW1hQ29sbGVjdGlvbikgPT5cbiAgICAgICAgICBzY2hlbWFDb2xsZWN0aW9uLmZpbmRBbmREZWxldGVTY2hlbWEoY2xhc3NOYW1lKVxuICAgICAgICApXG4gICAgICAgIC5jYXRjaCgoZXJyKSA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpXG4gICAgKTtcbiAgfVxuXG4gIGRlbGV0ZUFsbENsYXNzZXMoZmFzdDogYm9vbGVhbikge1xuICAgIHJldHVybiBzdG9yYWdlQWRhcHRlckFsbENvbGxlY3Rpb25zKHRoaXMpLnRoZW4oKGNvbGxlY3Rpb25zKSA9PlxuICAgICAgUHJvbWlzZS5hbGwoXG4gICAgICAgIGNvbGxlY3Rpb25zLm1hcCgoY29sbGVjdGlvbikgPT5cbiAgICAgICAgICBmYXN0ID8gY29sbGVjdGlvbi5kZWxldGVNYW55KHt9KSA6IGNvbGxlY3Rpb24uZHJvcCgpXG4gICAgICAgIClcbiAgICAgIClcbiAgICApO1xuICB9XG5cbiAgLy8gUmVtb3ZlIHRoZSBjb2x1bW4gYW5kIGFsbCB0aGUgZGF0YS4gRm9yIFJlbGF0aW9ucywgdGhlIF9Kb2luIGNvbGxlY3Rpb24gaXMgaGFuZGxlZFxuICAvLyBzcGVjaWFsbHksIHRoaXMgZnVuY3Rpb24gZG9lcyBub3QgZGVsZXRlIF9Kb2luIGNvbHVtbnMuIEl0IHNob3VsZCwgaG93ZXZlciwgaW5kaWNhdGVcbiAgLy8gdGhhdCB0aGUgcmVsYXRpb24gZmllbGRzIGRvZXMgbm90IGV4aXN0IGFueW1vcmUuIEluIG1vbmdvLCB0aGlzIG1lYW5zIHJlbW92aW5nIGl0IGZyb21cbiAgLy8gdGhlIF9TQ0hFTUEgY29sbGVjdGlvbi4gIFRoZXJlIHNob3VsZCBiZSBubyBhY3R1YWwgZGF0YSBpbiB0aGUgY29sbGVjdGlvbiB1bmRlciB0aGUgc2FtZSBuYW1lXG4gIC8vIGFzIHRoZSByZWxhdGlvbiBjb2x1bW4sIHNvIGl0J3MgZmluZSB0byBhdHRlbXB0IHRvIGRlbGV0ZSBpdC4gSWYgdGhlIGZpZWxkcyBsaXN0ZWQgdG8gYmVcbiAgLy8gZGVsZXRlZCBkbyBub3QgZXhpc3QsIHRoaXMgZnVuY3Rpb24gc2hvdWxkIHJldHVybiBzdWNjZXNzZnVsbHkgYW55d2F5cy4gQ2hlY2tpbmcgZm9yXG4gIC8vIGF0dGVtcHRzIHRvIGRlbGV0ZSBub24tZXhpc3RlbnQgZmllbGRzIGlzIHRoZSByZXNwb25zaWJpbGl0eSBvZiBQYXJzZSBTZXJ2ZXIuXG5cbiAgLy8gUG9pbnRlciBmaWVsZCBuYW1lcyBhcmUgcGFzc2VkIGZvciBsZWdhY3kgcmVhc29uczogdGhlIG9yaWdpbmFsIG1vbmdvXG4gIC8vIGZvcm1hdCBzdG9yZWQgcG9pbnRlciBmaWVsZCBuYW1lcyBkaWZmZXJlbnRseSBpbiB0aGUgZGF0YWJhc2UsIGFuZCB0aGVyZWZvcmVcbiAgLy8gbmVlZGVkIHRvIGtub3cgdGhlIHR5cGUgb2YgdGhlIGZpZWxkIGJlZm9yZSBpdCBjb3VsZCBkZWxldGUgaXQuIEZ1dHVyZSBkYXRhYmFzZVxuICAvLyBhZGFwdGVycyBzaG91bGQgaWdub3JlIHRoZSBwb2ludGVyRmllbGROYW1lcyBhcmd1bWVudC4gQWxsIHRoZSBmaWVsZCBuYW1lcyBhcmUgaW5cbiAgLy8gZmllbGROYW1lcywgdGhleSBzaG93IHVwIGFkZGl0aW9uYWxseSBpbiB0aGUgcG9pbnRlckZpZWxkTmFtZXMgZGF0YWJhc2UgZm9yIHVzZVxuICAvLyBieSB0aGUgbW9uZ28gYWRhcHRlciwgd2hpY2ggZGVhbHMgd2l0aCB0aGUgbGVnYWN5IG1vbmdvIGZvcm1hdC5cblxuICAvLyBUaGlzIGZ1bmN0aW9uIGlzIG5vdCBvYmxpZ2F0ZWQgdG8gZGVsZXRlIGZpZWxkcyBhdG9taWNhbGx5LiBJdCBpcyBnaXZlbiB0aGUgZmllbGRcbiAgLy8gbmFtZXMgaW4gYSBsaXN0IHNvIHRoYXQgZGF0YWJhc2VzIHRoYXQgYXJlIGNhcGFibGUgb2YgZGVsZXRpbmcgZmllbGRzIGF0b21pY2FsbHlcbiAgLy8gbWF5IGRvIHNvLlxuXG4gIC8vIFJldHVybnMgYSBQcm9taXNlLlxuICBkZWxldGVGaWVsZHMoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgZmllbGROYW1lczogc3RyaW5nW10pIHtcbiAgICBjb25zdCBtb25nb0Zvcm1hdE5hbWVzID0gZmllbGROYW1lcy5tYXAoKGZpZWxkTmFtZSkgPT4ge1xuICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgcmV0dXJuIGBfcF8ke2ZpZWxkTmFtZX1gO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIGZpZWxkTmFtZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBjb25zdCBjb2xsZWN0aW9uVXBkYXRlID0geyAkdW5zZXQ6IHt9IH07XG4gICAgbW9uZ29Gb3JtYXROYW1lcy5mb3JFYWNoKChuYW1lKSA9PiB7XG4gICAgICBjb2xsZWN0aW9uVXBkYXRlWyckdW5zZXQnXVtuYW1lXSA9IG51bGw7XG4gICAgfSk7XG5cbiAgICBjb25zdCBzY2hlbWFVcGRhdGUgPSB7ICR1bnNldDoge30gfTtcbiAgICBmaWVsZE5hbWVzLmZvckVhY2goKG5hbWUpID0+IHtcbiAgICAgIHNjaGVtYVVwZGF0ZVsnJHVuc2V0J11bbmFtZV0gPSBudWxsO1xuICAgICAgc2NoZW1hVXBkYXRlWyckdW5zZXQnXVtgX21ldGFkYXRhLmZpZWxkc19vcHRpb25zLiR7bmFtZX1gXSA9IG51bGw7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKChjb2xsZWN0aW9uKSA9PiBjb2xsZWN0aW9uLnVwZGF0ZU1hbnkoe30sIGNvbGxlY3Rpb25VcGRhdGUpKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpKVxuICAgICAgLnRoZW4oKHNjaGVtYUNvbGxlY3Rpb24pID0+XG4gICAgICAgIHNjaGVtYUNvbGxlY3Rpb24udXBkYXRlU2NoZW1hKGNsYXNzTmFtZSwgc2NoZW1hVXBkYXRlKVxuICAgICAgKVxuICAgICAgLmNhdGNoKChlcnIpID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBSZXR1cm4gYSBwcm9taXNlIGZvciBhbGwgc2NoZW1hcyBrbm93biB0byB0aGlzIGFkYXB0ZXIsIGluIFBhcnNlIGZvcm1hdC4gSW4gY2FzZSB0aGVcbiAgLy8gc2NoZW1hcyBjYW5ub3QgYmUgcmV0cmlldmVkLCByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlamVjdHMuIFJlcXVpcmVtZW50cyBmb3IgdGhlXG4gIC8vIHJlamVjdGlvbiByZWFzb24gYXJlIFRCRC5cbiAgZ2V0QWxsQ2xhc3NlcygpOiBQcm9taXNlPFN0b3JhZ2VDbGFzc1tdPiB7XG4gICAgcmV0dXJuIHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKVxuICAgICAgLnRoZW4oKHNjaGVtYXNDb2xsZWN0aW9uKSA9PlxuICAgICAgICBzY2hlbWFzQ29sbGVjdGlvbi5fZmV0Y2hBbGxTY2hlbWFzRnJvbV9TQ0hFTUEoKVxuICAgICAgKVxuICAgICAgLmNhdGNoKChlcnIpID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBSZXR1cm4gYSBwcm9taXNlIGZvciB0aGUgc2NoZW1hIHdpdGggdGhlIGdpdmVuIG5hbWUsIGluIFBhcnNlIGZvcm1hdC4gSWZcbiAgLy8gdGhpcyBhZGFwdGVyIGRvZXNuJ3Qga25vdyBhYm91dCB0aGUgc2NoZW1hLCByZXR1cm4gYSBwcm9taXNlIHRoYXQgcmVqZWN0cyB3aXRoXG4gIC8vIHVuZGVmaW5lZCBhcyB0aGUgcmVhc29uLlxuICBnZXRDbGFzcyhjbGFzc05hbWU6IHN0cmluZyk6IFByb21pc2U8U3RvcmFnZUNsYXNzPiB7XG4gICAgcmV0dXJuIHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKVxuICAgICAgLnRoZW4oKHNjaGVtYXNDb2xsZWN0aW9uKSA9PlxuICAgICAgICBzY2hlbWFzQ29sbGVjdGlvbi5fZmV0Y2hPbmVTY2hlbWFGcm9tX1NDSEVNQShjbGFzc05hbWUpXG4gICAgICApXG4gICAgICAuY2F0Y2goKGVycikgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIFRPRE86IEFzIHlldCBub3QgcGFydGljdWxhcmx5IHdlbGwgc3BlY2lmaWVkLiBDcmVhdGVzIGFuIG9iamVjdC4gTWF5YmUgc2hvdWxkbid0IGV2ZW4gbmVlZCB0aGUgc2NoZW1hLFxuICAvLyBhbmQgc2hvdWxkIGluZmVyIGZyb20gdGhlIHR5cGUuIE9yIG1heWJlIGRvZXMgbmVlZCB0aGUgc2NoZW1hIGZvciB2YWxpZGF0aW9ucy4gT3IgbWF5YmUgbmVlZHNcbiAgLy8gdGhlIHNjaGVtYSBvbmx5IGZvciB0aGUgbGVnYWN5IG1vbmdvIGZvcm1hdC4gV2UnbGwgZmlndXJlIHRoYXQgb3V0IGxhdGVyLlxuICBjcmVhdGVPYmplY3QoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIG9iamVjdDogYW55LFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb09iamVjdCA9IHBhcnNlT2JqZWN0VG9Nb25nb09iamVjdEZvckNyZWF0ZShcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIG9iamVjdCxcbiAgICAgIHNjaGVtYVxuICAgICk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbigoY29sbGVjdGlvbikgPT5cbiAgICAgICAgY29sbGVjdGlvbi5pbnNlcnRPbmUobW9uZ29PYmplY3QsIHRyYW5zYWN0aW9uYWxTZXNzaW9uKVxuICAgICAgKVxuICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gMTEwMDApIHtcbiAgICAgICAgICAvLyBEdXBsaWNhdGUgdmFsdWVcbiAgICAgICAgICBjb25zdCBlcnIgPSBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsXG4gICAgICAgICAgICAnQSBkdXBsaWNhdGUgdmFsdWUgZm9yIGEgZmllbGQgd2l0aCB1bmlxdWUgdmFsdWVzIHdhcyBwcm92aWRlZCdcbiAgICAgICAgICApO1xuICAgICAgICAgIGVyci51bmRlcmx5aW5nRXJyb3IgPSBlcnJvcjtcbiAgICAgICAgICBpZiAoZXJyb3IubWVzc2FnZSkge1xuICAgICAgICAgICAgY29uc3QgbWF0Y2hlcyA9IGVycm9yLm1lc3NhZ2UubWF0Y2goXG4gICAgICAgICAgICAgIC9pbmRleDpbXFxzYS16QS1aMC05X1xcLVxcLl0rXFwkPyhbYS16QS1aXy1dKylfMS9cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAobWF0Y2hlcyAmJiBBcnJheS5pc0FycmF5KG1hdGNoZXMpKSB7XG4gICAgICAgICAgICAgIGVyci51c2VySW5mbyA9IHsgZHVwbGljYXRlZF9maWVsZDogbWF0Y2hlc1sxXSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnIpID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBBZGRlZCB0byBhbGxvdyB0aGUgY3JlYXRpb24gb2YgbXVsdGlwbGUgb2JqZWN0cyBhdCBvbmNlXG4gIGNyZWF0ZU9iamVjdHMoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIG9iamVjdHM6IGFueSxcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbjogP2FueVxuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29PYmplY3RzID0gb2JqZWN0cy5tYXAob2JqZWN0ID0+XG4gICAgICBwYXJzZU9iamVjdFRvTW9uZ29PYmplY3RGb3JDcmVhdGUoY2xhc3NOYW1lLCBvYmplY3QsIHNjaGVtYSlcbiAgICApO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLmluc2VydE1hbnkobW9uZ29PYmplY3RzLCB0cmFuc2FjdGlvbmFsU2Vzc2lvbilcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSAxMTAwMCkge1xuICAgICAgICAgIC8vIER1cGxpY2F0ZSB2YWx1ZVxuICAgICAgICAgIGNvbnN0IGVyciA9IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICk7XG4gICAgICAgICAgZXJyLnVuZGVybHlpbmdFcnJvciA9IGVycm9yO1xuICAgICAgICAgIGlmIChlcnJvci5tZXNzYWdlKSB7XG4gICAgICAgICAgICBjb25zdCBtYXRjaGVzID0gZXJyb3IubWVzc2FnZS5tYXRjaChcbiAgICAgICAgICAgICAgL2luZGV4OltcXHNhLXpBLVowLTlfXFwtXFwuXStcXCQ/KFthLXpBLVpfLV0rKV8xL1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmIChtYXRjaGVzICYmIEFycmF5LmlzQXJyYXkobWF0Y2hlcykpIHtcbiAgICAgICAgICAgICAgZXJyLnVzZXJJbmZvID0geyBkdXBsaWNhdGVkX2ZpZWxkOiBtYXRjaGVzWzFdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBSZW1vdmUgYWxsIG9iamVjdHMgdGhhdCBtYXRjaCB0aGUgZ2l2ZW4gUGFyc2UgUXVlcnkuXG4gIC8vIElmIG5vIG9iamVjdHMgbWF0Y2gsIHJlamVjdCB3aXRoIE9CSkVDVF9OT1RfRk9VTkQuIElmIG9iamVjdHMgYXJlIGZvdW5kIGFuZCBkZWxldGVkLCByZXNvbHZlIHdpdGggdW5kZWZpbmVkLlxuICAvLyBJZiB0aGVyZSBpcyBzb21lIG90aGVyIGVycm9yLCByZWplY3Qgd2l0aCBJTlRFUk5BTF9TRVJWRVJfRVJST1IuXG4gIGRlbGV0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKChjb2xsZWN0aW9uKSA9PiB7XG4gICAgICAgIGNvbnN0IG1vbmdvV2hlcmUgPSB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpO1xuICAgICAgICByZXR1cm4gY29sbGVjdGlvbi5kZWxldGVNYW55KG1vbmdvV2hlcmUsIHRyYW5zYWN0aW9uYWxTZXNzaW9uKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goKGVycikgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKVxuICAgICAgLnRoZW4oXG4gICAgICAgICh7IHJlc3VsdCB9KSA9PiB7XG4gICAgICAgICAgaWYgKHJlc3VsdC5uID09PSAwKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsXG4gICAgICAgICAgICAgICdPYmplY3Qgbm90IGZvdW5kLidcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgfSxcbiAgICAgICAgKCkgPT4ge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVEVSTkFMX1NFUlZFUl9FUlJPUixcbiAgICAgICAgICAgICdEYXRhYmFzZSBhZGFwdGVyIGVycm9yJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICk7XG4gIH1cblxuICAvLyBBcHBseSB0aGUgdXBkYXRlIHRvIGFsbCBvYmplY3RzIHRoYXQgbWF0Y2ggdGhlIGdpdmVuIFBhcnNlIFF1ZXJ5LlxuICB1cGRhdGVPYmplY3RzQnlRdWVyeShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICB1cGRhdGU6IGFueSxcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbjogP2FueVxuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29VcGRhdGUgPSB0cmFuc2Zvcm1VcGRhdGUoY2xhc3NOYW1lLCB1cGRhdGUsIHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29XaGVyZSA9IHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbigoY29sbGVjdGlvbikgPT5cbiAgICAgICAgY29sbGVjdGlvbi51cGRhdGVNYW55KG1vbmdvV2hlcmUsIG1vbmdvVXBkYXRlLCB0cmFuc2FjdGlvbmFsU2Vzc2lvbilcbiAgICAgIClcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gQXRvbWljYWxseSBmaW5kcyBhbmQgdXBkYXRlcyBhbiBvYmplY3QgYmFzZWQgb24gcXVlcnkuXG4gIC8vIFJldHVybiB2YWx1ZSBub3QgY3VycmVudGx5IHdlbGwgc3BlY2lmaWVkLlxuICBmaW5kT25lQW5kVXBkYXRlKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHVwZGF0ZTogYW55LFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1VwZGF0ZSA9IHRyYW5zZm9ybVVwZGF0ZShjbGFzc05hbWUsIHVwZGF0ZSwgc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1doZXJlID0gdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hKTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKChjb2xsZWN0aW9uKSA9PlxuICAgICAgICBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uZmluZE9uZUFuZFVwZGF0ZShtb25nb1doZXJlLCBtb25nb1VwZGF0ZSwge1xuICAgICAgICAgIHJldHVybk9yaWdpbmFsOiBmYWxzZSxcbiAgICAgICAgICBzZXNzaW9uOiB0cmFuc2FjdGlvbmFsU2Vzc2lvbiB8fCB1bmRlZmluZWQsXG4gICAgICAgIH0pXG4gICAgICApXG4gICAgICAudGhlbigocmVzdWx0KSA9PlxuICAgICAgICBtb25nb09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lLCByZXN1bHQudmFsdWUsIHNjaGVtYSlcbiAgICAgIClcbiAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IDExMDAwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICAgJ0EgZHVwbGljYXRlIHZhbHVlIGZvciBhIGZpZWxkIHdpdGggdW5pcXVlIHZhbHVlcyB3YXMgcHJvdmlkZWQnXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goKGVycikgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIHVwZGF0ZU9iamVjdHNCeUJ1bGsoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIG9wZXJhdGlvbnM6IGFueSxcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbjogP2FueVxuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgYnVsa3MgPSBvcGVyYXRpb25zLm1hcCgoe3VwZGF0ZU9uZSwgdXBkYXRlTWFueSwgaW5zZXJ0T25lfSkgPT4ge1xuICAgICAgcmV0dXJuIHVwZGF0ZU9uZSA/IHtcbiAgICAgICAgdXBkYXRlT25lOiB7XG4gICAgICAgICAgZmlsdGVyOiB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHVwZGF0ZU9uZS5maWx0ZXIsIHNjaGVtYSksXG4gICAgICAgICAgdXBkYXRlOiB0cmFuc2Zvcm1VcGRhdGUoY2xhc3NOYW1lLCB1cGRhdGVPbmUudXBkYXRlLCBzY2hlbWEpLFxuICAgICAgICAgIHVwc2VydDogZmFsc2VcbiAgICAgICAgfVxuICAgICAgfSA6IHVwZGF0ZU1hbnkgPyB7XG4gICAgICAgIHVwZGF0ZU1hbnk6IHtcbiAgICAgICAgICBmaWx0ZXI6IHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgdXBkYXRlTWFueS5maWx0ZXIsIHNjaGVtYSksXG4gICAgICAgICAgdXBkYXRlOiB0cmFuc2Zvcm1VcGRhdGUoY2xhc3NOYW1lLCB1cGRhdGVNYW55LnVwZGF0ZSwgc2NoZW1hKSxcbiAgICAgICAgICB1cHNlcnQ6IGZhbHNlXG4gICAgICAgIH1cbiAgICAgIH0gOiB7XG4gICAgICAgIGluc2VydE9uZToge1xuICAgICAgICAgIGRvY3VtZW50OiBwYXJzZU9iamVjdFRvTW9uZ29PYmplY3RGb3JDcmVhdGUoY2xhc3NOYW1lLCBpbnNlcnRPbmUuZG9jdW1lbnQsIHNjaGVtYSlcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICB9KTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT5cbiAgICAgICAgY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLmJ1bGtXcml0ZShidWxrcywge1xuICAgICAgICAgIHNlc3Npb246IHRyYW5zYWN0aW9uYWxTZXNzaW9uIHx8IHVuZGVmaW5lZFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLnRoZW4ocmVzdWx0ID0+IG1vbmdvT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIHJlc3VsdC52YWx1ZSwgc2NoZW1hKSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSAxMTAwMCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gSG9wZWZ1bGx5IHdlIGNhbiBnZXQgcmlkIG9mIHRoaXMuIEl0J3Mgb25seSB1c2VkIGZvciBjb25maWcgYW5kIGhvb2tzLlxuICB1cHNlcnRPbmVPYmplY3QoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgdXBkYXRlOiBhbnksXG4gICAgdHJhbnNhY3Rpb25hbFNlc3Npb246ID9hbnlcbiAgKSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvVXBkYXRlID0gdHJhbnNmb3JtVXBkYXRlKGNsYXNzTmFtZSwgdXBkYXRlLCBzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvV2hlcmUgPSB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oKGNvbGxlY3Rpb24pID0+XG4gICAgICAgIGNvbGxlY3Rpb24udXBzZXJ0T25lKG1vbmdvV2hlcmUsIG1vbmdvVXBkYXRlLCB0cmFuc2FjdGlvbmFsU2Vzc2lvbilcbiAgICAgIClcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gRXhlY3V0ZXMgYSBmaW5kLiBBY2NlcHRzOiBjbGFzc05hbWUsIHF1ZXJ5IGluIFBhcnNlIGZvcm1hdCwgYW5kIHsgc2tpcCwgbGltaXQsIHNvcnQgfS5cbiAgZmluZChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICB7XG4gICAgICBza2lwLFxuICAgICAgbGltaXQsXG4gICAgICBzb3J0LFxuICAgICAga2V5cyxcbiAgICAgIHJlYWRQcmVmZXJlbmNlLFxuICAgICAgaGludCxcbiAgICAgIGNhc2VJbnNlbnNpdGl2ZSxcbiAgICAgIGV4cGxhaW4sXG4gICAgfTogUXVlcnlPcHRpb25zXG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvV2hlcmUgPSB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvU29ydCA9IF8ubWFwS2V5cyhzb3J0LCAodmFsdWUsIGZpZWxkTmFtZSkgPT5cbiAgICAgIHRyYW5zZm9ybUtleShjbGFzc05hbWUsIGZpZWxkTmFtZSwgc2NoZW1hKVxuICAgICk7XG4gICAgY29uc3QgbW9uZ29LZXlzID0gXy5yZWR1Y2UoXG4gICAgICBrZXlzLFxuICAgICAgKG1lbW8sIGtleSkgPT4ge1xuICAgICAgICBpZiAoa2V5ID09PSAnQUNMJykge1xuICAgICAgICAgIG1lbW9bJ19ycGVybSddID0gMTtcbiAgICAgICAgICBtZW1vWydfd3Blcm0nXSA9IDE7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgbWVtb1t0cmFuc2Zvcm1LZXkoY2xhc3NOYW1lLCBrZXksIHNjaGVtYSldID0gMTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbWVtbztcbiAgICAgIH0sXG4gICAgICB7fVxuICAgICk7XG5cbiAgICAvLyBJZiB3ZSBhcmVuJ3QgcmVxdWVzdGluZyB0aGUgYF9pZGAgZmllbGQsIHdlIG5lZWQgdG8gZXhwbGljaXRseSBvcHQgb3V0XG4gICAgLy8gb2YgaXQuIERvaW5nIHNvIGluIHBhcnNlLXNlcnZlciBpcyB1bnVzdWFsLCBidXQgaXQgY2FuIGFsbG93IHVzIHRvXG4gICAgLy8gb3B0aW1pemUgc29tZSBxdWVyaWVzIHdpdGggY292ZXJpbmcgaW5kZXhlcy5cbiAgICBpZiAoa2V5cyAmJiAhbW9uZ29LZXlzLl9pZCkge1xuICAgICAgbW9uZ29LZXlzLl9pZCA9IDA7XG4gICAgfVxuXG4gICAgcmVhZFByZWZlcmVuY2UgPSB0aGlzLl9wYXJzZVJlYWRQcmVmZXJlbmNlKHJlYWRQcmVmZXJlbmNlKTtcbiAgICByZXR1cm4gdGhpcy5jcmVhdGVUZXh0SW5kZXhlc0lmTmVlZGVkKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSlcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpKVxuICAgICAgLnRoZW4oKGNvbGxlY3Rpb24pID0+XG4gICAgICAgIGNvbGxlY3Rpb24uZmluZChtb25nb1doZXJlLCB7XG4gICAgICAgICAgc2tpcCxcbiAgICAgICAgICBsaW1pdCxcbiAgICAgICAgICBzb3J0OiBtb25nb1NvcnQsXG4gICAgICAgICAga2V5czogbW9uZ29LZXlzLFxuICAgICAgICAgIG1heFRpbWVNUzogdGhpcy5fbWF4VGltZU1TLFxuICAgICAgICAgIHJlYWRQcmVmZXJlbmNlLFxuICAgICAgICAgIGhpbnQsXG4gICAgICAgICAgY2FzZUluc2Vuc2l0aXZlLFxuICAgICAgICAgIGV4cGxhaW4sXG4gICAgICAgIH0pXG4gICAgICApXG4gICAgICAudGhlbigob2JqZWN0cykgPT4ge1xuICAgICAgICBpZiAoZXhwbGFpbikge1xuICAgICAgICAgIHJldHVybiBvYmplY3RzO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBvYmplY3RzLm1hcCgob2JqZWN0KSA9PlxuICAgICAgICAgIG1vbmdvT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKVxuICAgICAgICApO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgZW5zdXJlSW5kZXgoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIGZpZWxkTmFtZXM6IHN0cmluZ1tdLFxuICAgIGluZGV4TmFtZTogP3N0cmluZyxcbiAgICBjYXNlSW5zZW5zaXRpdmU6IGJvb2xlYW4gPSBmYWxzZSxcbiAgICBvcHRpb25zPzogT2JqZWN0ID0ge30sXG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IGluZGV4Q3JlYXRpb25SZXF1ZXN0ID0ge307XG4gICAgY29uc3QgbW9uZ29GaWVsZE5hbWVzID0gZmllbGROYW1lcy5tYXAoKGZpZWxkTmFtZSkgPT5cbiAgICAgIHRyYW5zZm9ybUtleShjbGFzc05hbWUsIGZpZWxkTmFtZSwgc2NoZW1hKVxuICAgICk7XG4gICAgbW9uZ29GaWVsZE5hbWVzLmZvckVhY2goKGZpZWxkTmFtZSkgPT4ge1xuICAgICAgaW5kZXhDcmVhdGlvblJlcXVlc3RbZmllbGROYW1lXSA9IG9wdGlvbnMuaW5kZXhUeXBlICE9PSB1bmRlZmluZWQgPyBvcHRpb25zLmluZGV4VHlwZSA6IDE7XG4gICAgfSk7XG5cbiAgICBjb25zdCBkZWZhdWx0T3B0aW9uczogT2JqZWN0ID0geyBiYWNrZ3JvdW5kOiB0cnVlLCBzcGFyc2U6IHRydWUgfTtcbiAgICBjb25zdCBpbmRleE5hbWVPcHRpb25zOiBPYmplY3QgPSBpbmRleE5hbWUgPyB7IG5hbWU6IGluZGV4TmFtZSB9IDoge307XG4gICAgY29uc3QgdHRsT3B0aW9uczogT2JqZWN0ID0gb3B0aW9ucy50dGwgIT09IHVuZGVmaW5lZCA/IHsgZXhwaXJlQWZ0ZXJTZWNvbmRzOiBvcHRpb25zLnR0bCB9IDoge307XG4gICAgY29uc3QgY2FzZUluc2Vuc2l0aXZlT3B0aW9uczogT2JqZWN0ID0gY2FzZUluc2Vuc2l0aXZlXG4gICAgICA/IHsgY29sbGF0aW9uOiBNb25nb0NvbGxlY3Rpb24uY2FzZUluc2Vuc2l0aXZlQ29sbGF0aW9uKCkgfVxuICAgICAgOiB7fTtcbiAgICBjb25zdCBpbmRleE9wdGlvbnM6IE9iamVjdCA9IHtcbiAgICAgIC4uLmRlZmF1bHRPcHRpb25zLFxuICAgICAgLi4uY2FzZUluc2Vuc2l0aXZlT3B0aW9ucyxcbiAgICAgIC4uLmluZGV4TmFtZU9wdGlvbnMsXG4gICAgICAuLi50dGxPcHRpb25zLFxuICAgIH07XG5cbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKFxuICAgICAgICAoY29sbGVjdGlvbikgPT5cbiAgICAgICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PlxuICAgICAgICAgICAgY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLmNyZWF0ZUluZGV4KFxuICAgICAgICAgICAgICBpbmRleENyZWF0aW9uUmVxdWVzdCxcbiAgICAgICAgICAgICAgaW5kZXhPcHRpb25zLFxuICAgICAgICAgICAgICAoZXJyb3IpID0+IChlcnJvciA/IHJlamVjdChlcnJvcikgOiByZXNvbHZlKCkpXG4gICAgICAgICAgICApXG4gICAgICAgICAgKVxuICAgICAgKVxuICAgICAgLmNhdGNoKChlcnIpID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBDcmVhdGUgYSB1bmlxdWUgaW5kZXguIFVuaXF1ZSBpbmRleGVzIG9uIG51bGxhYmxlIGZpZWxkcyBhcmUgbm90IGFsbG93ZWQuIFNpbmNlIHdlIGRvbid0XG4gIC8vIGN1cnJlbnRseSBrbm93IHdoaWNoIGZpZWxkcyBhcmUgbnVsbGFibGUgYW5kIHdoaWNoIGFyZW4ndCwgd2UgaWdub3JlIHRoYXQgY3JpdGVyaWEuXG4gIC8vIEFzIHN1Y2gsIHdlIHNob3VsZG4ndCBleHBvc2UgdGhpcyBmdW5jdGlvbiB0byB1c2VycyBvZiBwYXJzZSB1bnRpbCB3ZSBoYXZlIGFuIG91dC1vZi1iYW5kXG4gIC8vIFdheSBvZiBkZXRlcm1pbmluZyBpZiBhIGZpZWxkIGlzIG51bGxhYmxlLiBVbmRlZmluZWQgZG9lc24ndCBjb3VudCBhZ2FpbnN0IHVuaXF1ZW5lc3MsXG4gIC8vIHdoaWNoIGlzIHdoeSB3ZSB1c2Ugc3BhcnNlIGluZGV4ZXMuXG4gIGVuc3VyZVVuaXF1ZW5lc3MoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIGZpZWxkTmFtZXM6IHN0cmluZ1tdXG4gICkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBpbmRleENyZWF0aW9uUmVxdWVzdCA9IHt9O1xuICAgIGNvbnN0IG1vbmdvRmllbGROYW1lcyA9IGZpZWxkTmFtZXMubWFwKChmaWVsZE5hbWUpID0+XG4gICAgICB0cmFuc2Zvcm1LZXkoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHNjaGVtYSlcbiAgICApO1xuICAgIG1vbmdvRmllbGROYW1lcy5mb3JFYWNoKChmaWVsZE5hbWUpID0+IHtcbiAgICAgIGluZGV4Q3JlYXRpb25SZXF1ZXN0W2ZpZWxkTmFtZV0gPSAxO1xuICAgIH0pO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oKGNvbGxlY3Rpb24pID0+XG4gICAgICAgIGNvbGxlY3Rpb24uX2Vuc3VyZVNwYXJzZVVuaXF1ZUluZGV4SW5CYWNrZ3JvdW5kKGluZGV4Q3JlYXRpb25SZXF1ZXN0KVxuICAgICAgKVxuICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gMTEwMDApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsXG4gICAgICAgICAgICAnVHJpZWQgdG8gZW5zdXJlIGZpZWxkIHVuaXF1ZW5lc3MgZm9yIGEgY2xhc3MgdGhhdCBhbHJlYWR5IGhhcyBkdXBsaWNhdGVzLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gVXNlZCBpbiB0ZXN0c1xuICBfcmF3RmluZChjbGFzc05hbWU6IHN0cmluZywgcXVlcnk6IFF1ZXJ5VHlwZSkge1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oKGNvbGxlY3Rpb24pID0+XG4gICAgICAgIGNvbGxlY3Rpb24uZmluZChxdWVyeSwge1xuICAgICAgICAgIG1heFRpbWVNUzogdGhpcy5fbWF4VGltZU1TLFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLmNhdGNoKChlcnIpID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBFeGVjdXRlcyBhIGNvdW50LlxuICBjb3VudChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICByZWFkUHJlZmVyZW5jZTogP3N0cmluZyxcbiAgICBoaW50OiA/bWl4ZWRcbiAgKSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIHJlYWRQcmVmZXJlbmNlID0gdGhpcy5fcGFyc2VSZWFkUHJlZmVyZW5jZShyZWFkUHJlZmVyZW5jZSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbigoY29sbGVjdGlvbikgPT5cbiAgICAgICAgY29sbGVjdGlvbi5jb3VudCh0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEsIHRydWUpLCB7XG4gICAgICAgICAgbWF4VGltZU1TOiB0aGlzLl9tYXhUaW1lTVMsXG4gICAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICAgICAgaGludCxcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgZGlzdGluY3QoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgZmllbGROYW1lOiBzdHJpbmdcbiAgKSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IGlzUG9pbnRlckZpZWxkID1cbiAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1BvaW50ZXInO1xuICAgIGNvbnN0IHRyYW5zZm9ybUZpZWxkID0gdHJhbnNmb3JtS2V5KGNsYXNzTmFtZSwgZmllbGROYW1lLCBzY2hlbWEpO1xuXG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbigoY29sbGVjdGlvbikgPT5cbiAgICAgICAgY29sbGVjdGlvbi5kaXN0aW5jdChcbiAgICAgICAgICB0cmFuc2Zvcm1GaWVsZCxcbiAgICAgICAgICB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpXG4gICAgICAgIClcbiAgICAgIClcbiAgICAgIC50aGVuKChvYmplY3RzKSA9PiB7XG4gICAgICAgIG9iamVjdHMgPSBvYmplY3RzLmZpbHRlcigob2JqKSA9PiBvYmogIT0gbnVsbCk7XG4gICAgICAgIHJldHVybiBvYmplY3RzLm1hcCgob2JqZWN0KSA9PiB7XG4gICAgICAgICAgaWYgKGlzUG9pbnRlckZpZWxkKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJhbnNmb3JtUG9pbnRlclN0cmluZyhzY2hlbWEsIGZpZWxkTmFtZSwgb2JqZWN0KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIG1vbmdvT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKTtcbiAgICAgICAgfSk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnIpID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBhZ2dyZWdhdGUoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBhbnksXG4gICAgcGlwZWxpbmU6IGFueSxcbiAgICByZWFkUHJlZmVyZW5jZTogP3N0cmluZyxcbiAgICBoaW50OiA/bWl4ZWQsXG4gICAgZXhwbGFpbj86IGJvb2xlYW5cbiAgKSB7XG4gICAgbGV0IGlzUG9pbnRlckZpZWxkID0gZmFsc2U7XG4gICAgcGlwZWxpbmUgPSBwaXBlbGluZS5tYXAoKHN0YWdlKSA9PiB7XG4gICAgICBpZiAoc3RhZ2UuJGdyb3VwKSB7XG4gICAgICAgIHN0YWdlLiRncm91cCA9IHRoaXMuX3BhcnNlQWdncmVnYXRlR3JvdXBBcmdzKHNjaGVtYSwgc3RhZ2UuJGdyb3VwKTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHN0YWdlLiRncm91cC5faWQgJiZcbiAgICAgICAgICB0eXBlb2Ygc3RhZ2UuJGdyb3VwLl9pZCA9PT0gJ3N0cmluZycgJiZcbiAgICAgICAgICBzdGFnZS4kZ3JvdXAuX2lkLmluZGV4T2YoJyRfcF8nKSA+PSAwXG4gICAgICAgICkge1xuICAgICAgICAgIGlzUG9pbnRlckZpZWxkID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHN0YWdlLiRtYXRjaCkge1xuICAgICAgICBzdGFnZS4kbWF0Y2ggPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUFyZ3Moc2NoZW1hLCBzdGFnZS4kbWF0Y2gpO1xuICAgICAgfVxuICAgICAgaWYgKHN0YWdlLiRwcm9qZWN0KSB7XG4gICAgICAgIHN0YWdlLiRwcm9qZWN0ID0gdGhpcy5fcGFyc2VBZ2dyZWdhdGVQcm9qZWN0QXJncyhcbiAgICAgICAgICBzY2hlbWEsXG4gICAgICAgICAgc3RhZ2UuJHByb2plY3RcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChzdGFnZS4kZ2VvTmVhcikge1xuICAgICAgICBzdGFnZS4kZ2VvTmVhci5xdWVyeSA9IHRoaXMuX3BhcnNlQWdncmVnYXRlQXJncyhcbiAgICAgICAgICBzY2hlbWEsXG4gICAgICAgICAgc3RhZ2UuJGdlb05lYXIucXVlcnlcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBzdGFnZTtcbiAgICB9KTtcbiAgICByZWFkUHJlZmVyZW5jZSA9IHRoaXMuX3BhcnNlUmVhZFByZWZlcmVuY2UocmVhZFByZWZlcmVuY2UpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oKGNvbGxlY3Rpb24pID0+XG4gICAgICAgIGNvbGxlY3Rpb24uYWdncmVnYXRlKHBpcGVsaW5lLCB7XG4gICAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICAgICAgbWF4VGltZU1TOiB0aGlzLl9tYXhUaW1lTVMsXG4gICAgICAgICAgaGludCxcbiAgICAgICAgICBleHBsYWluLFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLnRoZW4oKHJlc3VsdHMpID0+IHtcbiAgICAgICAgcmVzdWx0cy5mb3JFYWNoKChyZXN1bHQpID0+IHtcbiAgICAgICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlc3VsdCwgJ19pZCcpKSB7XG4gICAgICAgICAgICBpZiAoaXNQb2ludGVyRmllbGQgJiYgcmVzdWx0Ll9pZCkge1xuICAgICAgICAgICAgICByZXN1bHQuX2lkID0gcmVzdWx0Ll9pZC5zcGxpdCgnJCcpWzFdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICByZXN1bHQuX2lkID09IG51bGwgfHxcbiAgICAgICAgICAgICAgcmVzdWx0Ll9pZCA9PSB1bmRlZmluZWQgfHxcbiAgICAgICAgICAgICAgKFsnb2JqZWN0JywgJ3N0cmluZyddLmluY2x1ZGVzKHR5cGVvZiByZXN1bHQuX2lkKSAmJlxuICAgICAgICAgICAgICAgIF8uaXNFbXB0eShyZXN1bHQuX2lkKSlcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICByZXN1bHQuX2lkID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJlc3VsdC5vYmplY3RJZCA9IHJlc3VsdC5faWQ7XG4gICAgICAgICAgICBkZWxldGUgcmVzdWx0Ll9pZDtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gcmVzdWx0cztcbiAgICAgIH0pXG4gICAgICAudGhlbigob2JqZWN0cykgPT5cbiAgICAgICAgb2JqZWN0cy5tYXAoKG9iamVjdCkgPT5cbiAgICAgICAgICBtb25nb09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lLCBvYmplY3QsIHNjaGVtYSlcbiAgICAgICAgKVxuICAgICAgKVxuICAgICAgLmNhdGNoKChlcnIpID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBUaGlzIGZ1bmN0aW9uIHdpbGwgcmVjdXJzaXZlbHkgdHJhdmVyc2UgdGhlIHBpcGVsaW5lIGFuZCBjb252ZXJ0IGFueSBQb2ludGVyIG9yIERhdGUgY29sdW1ucy5cbiAgLy8gSWYgd2UgZGV0ZWN0IGEgcG9pbnRlciBjb2x1bW4gd2Ugd2lsbCByZW5hbWUgdGhlIGNvbHVtbiBiZWluZyBxdWVyaWVkIGZvciB0byBtYXRjaCB0aGUgY29sdW1uXG4gIC8vIGluIHRoZSBkYXRhYmFzZS4gV2UgYWxzbyBtb2RpZnkgdGhlIHZhbHVlIHRvIHdoYXQgd2UgZXhwZWN0IHRoZSB2YWx1ZSB0byBiZSBpbiB0aGUgZGF0YWJhc2VcbiAgLy8gYXMgd2VsbC5cbiAgLy8gRm9yIGRhdGVzLCB0aGUgZHJpdmVyIGV4cGVjdHMgYSBEYXRlIG9iamVjdCwgYnV0IHdlIGhhdmUgYSBzdHJpbmcgY29taW5nIGluLiBTbyB3ZSdsbCBjb252ZXJ0XG4gIC8vIHRoZSBzdHJpbmcgdG8gYSBEYXRlIHNvIHRoZSBkcml2ZXIgY2FuIHBlcmZvcm0gdGhlIG5lY2Vzc2FyeSBjb21wYXJpc29uLlxuICAvL1xuICAvLyBUaGUgZ29hbCBvZiB0aGlzIG1ldGhvZCBpcyB0byBsb29rIGZvciB0aGUgXCJsZWF2ZXNcIiBvZiB0aGUgcGlwZWxpbmUgYW5kIGRldGVybWluZSBpZiBpdCBuZWVkc1xuICAvLyB0byBiZSBjb252ZXJ0ZWQuIFRoZSBwaXBlbGluZSBjYW4gaGF2ZSBhIGZldyBkaWZmZXJlbnQgZm9ybXMuIEZvciBtb3JlIGRldGFpbHMsIHNlZTpcbiAgLy8gICAgIGh0dHBzOi8vZG9jcy5tb25nb2RiLmNvbS9tYW51YWwvcmVmZXJlbmNlL29wZXJhdG9yL2FnZ3JlZ2F0aW9uL1xuICAvL1xuICAvLyBJZiB0aGUgcGlwZWxpbmUgaXMgYW4gYXJyYXksIGl0IG1lYW5zIHdlIGFyZSBwcm9iYWJseSBwYXJzaW5nIGFuICckYW5kJyBvciAnJG9yJyBvcGVyYXRvci4gSW5cbiAgLy8gdGhhdCBjYXNlIHdlIG5lZWQgdG8gbG9vcCB0aHJvdWdoIGFsbCBvZiBpdCdzIGNoaWxkcmVuIHRvIGZpbmQgdGhlIGNvbHVtbnMgYmVpbmcgb3BlcmF0ZWQgb24uXG4gIC8vIElmIHRoZSBwaXBlbGluZSBpcyBhbiBvYmplY3QsIHRoZW4gd2UnbGwgbG9vcCB0aHJvdWdoIHRoZSBrZXlzIGNoZWNraW5nIHRvIHNlZSBpZiB0aGUga2V5IG5hbWVcbiAgLy8gbWF0Y2hlcyBvbmUgb2YgdGhlIHNjaGVtYSBjb2x1bW5zLiBJZiBpdCBkb2VzIG1hdGNoIGEgY29sdW1uIGFuZCB0aGUgY29sdW1uIGlzIGEgUG9pbnRlciBvclxuICAvLyBhIERhdGUsIHRoZW4gd2UnbGwgY29udmVydCB0aGUgdmFsdWUgYXMgZGVzY3JpYmVkIGFib3ZlLlxuICAvL1xuICAvLyBBcyBtdWNoIGFzIEkgaGF0ZSByZWN1cnNpb24uLi50aGlzIHNlZW1lZCBsaWtlIGEgZ29vZCBmaXQgZm9yIGl0LiBXZSdyZSBlc3NlbnRpYWxseSB0cmF2ZXJzaW5nXG4gIC8vIGRvd24gYSB0cmVlIHRvIGZpbmQgYSBcImxlYWYgbm9kZVwiIGFuZCBjaGVja2luZyB0byBzZWUgaWYgaXQgbmVlZHMgdG8gYmUgY29udmVydGVkLlxuICBfcGFyc2VBZ2dyZWdhdGVBcmdzKHNjaGVtYTogYW55LCBwaXBlbGluZTogYW55KTogYW55IHtcbiAgICBpZiAocGlwZWxpbmUgPT09IG51bGwpIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheShwaXBlbGluZSkpIHtcbiAgICAgIHJldHVybiBwaXBlbGluZS5tYXAodmFsdWUgPT4gdGhpcy5fcGFyc2VBZ2dyZWdhdGVBcmdzKHNjaGVtYSwgdmFsdWUpKTtcbiAgICB9IGVsc2UgaWYgKHBpcGVsaW5lIGluc3RhbmNlb2YgRGF0ZSkge1xuICAgICAgcmV0dXJuIHBpcGVsaW5lO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHBpcGVsaW5lID09PSAnb2JqZWN0Jykge1xuICAgICAgY29uc3QgcmV0dXJuVmFsdWUgPSB7fTtcbiAgICAgIGZvciAoY29uc3QgZmllbGQgaW4gcGlwZWxpbmUpIHtcbiAgICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGRdICYmIHNjaGVtYS5maWVsZHNbZmllbGRdLnR5cGUgPT09ICdQb2ludGVyJykge1xuICAgICAgICAgIGlmICh0eXBlb2YgcGlwZWxpbmVbZmllbGRdID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgLy8gUGFzcyBvYmplY3RzIGRvd24gdG8gTW9uZ29EQi4uLnRoaXMgaXMgbW9yZSB0aGFuIGxpa2VseSBhbiAkZXhpc3RzIG9wZXJhdG9yLlxuICAgICAgICAgICAgcmV0dXJuVmFsdWVbYF9wXyR7ZmllbGR9YF0gPSBwaXBlbGluZVtmaWVsZF07XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVyblZhbHVlW1xuICAgICAgICAgICAgICBgX3BfJHtmaWVsZH1gXG4gICAgICAgICAgICBdID0gYCR7c2NoZW1hLmZpZWxkc1tmaWVsZF0udGFyZ2V0Q2xhc3N9JCR7cGlwZWxpbmVbZmllbGRdfWA7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGRdICYmXG4gICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSA9PT0gJ0RhdGUnXG4gICAgICAgICkge1xuICAgICAgICAgIHJldHVyblZhbHVlW2ZpZWxkXSA9IHRoaXMuX2NvbnZlcnRUb0RhdGUocGlwZWxpbmVbZmllbGRdKTtcbiAgICAgICAgfSBlbHNlIGlmIChwaXBlbGluZVtmaWVsZF0gJiYgcGlwZWxpbmVbZmllbGRdLl9fdHlwZSA9PT0gXCJEYXRlXCIpIHtcbiAgICAgICAgICByZXR1cm5WYWx1ZVtmaWVsZF0gPSB0aGlzLl9jb252ZXJ0VG9EYXRlKHBpcGVsaW5lW2ZpZWxkXS5pc28pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJldHVyblZhbHVlW2ZpZWxkXSA9IHRoaXMuX3BhcnNlQWdncmVnYXRlQXJncyhcbiAgICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICAgIHBpcGVsaW5lW2ZpZWxkXVxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZmllbGQgPT09ICdvYmplY3RJZCcpIHtcbiAgICAgICAgICByZXR1cm5WYWx1ZVsnX2lkJ10gPSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgICAgZGVsZXRlIHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gJ2NyZWF0ZWRBdCcpIHtcbiAgICAgICAgICByZXR1cm5WYWx1ZVsnX2NyZWF0ZWRfYXQnXSA9IHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgICBkZWxldGUgcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICB9IGVsc2UgaWYgKGZpZWxkID09PSAndXBkYXRlZEF0Jykge1xuICAgICAgICAgIHJldHVyblZhbHVlWydfdXBkYXRlZF9hdCddID0gcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICAgIGRlbGV0ZSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiByZXR1cm5WYWx1ZTtcbiAgICB9XG4gICAgcmV0dXJuIHBpcGVsaW5lO1xuICB9XG5cbiAgLy8gVGhpcyBmdW5jdGlvbiBpcyBzbGlnaHRseSBkaWZmZXJlbnQgdGhhbiB0aGUgb25lIGFib3ZlLiBSYXRoZXIgdGhhbiB0cnlpbmcgdG8gY29tYmluZSB0aGVzZVxuICAvLyB0d28gZnVuY3Rpb25zIGFuZCBtYWtpbmcgdGhlIGNvZGUgZXZlbiBoYXJkZXIgdG8gdW5kZXJzdGFuZCwgSSBkZWNpZGVkIHRvIHNwbGl0IGl0IHVwLiBUaGVcbiAgLy8gZGlmZmVyZW5jZSB3aXRoIHRoaXMgZnVuY3Rpb24gaXMgd2UgYXJlIG5vdCB0cmFuc2Zvcm1pbmcgdGhlIHZhbHVlcywgb25seSB0aGUga2V5cyBvZiB0aGVcbiAgLy8gcGlwZWxpbmUuXG4gIF9wYXJzZUFnZ3JlZ2F0ZVByb2plY3RBcmdzKHNjaGVtYTogYW55LCBwaXBlbGluZTogYW55KTogYW55IHtcbiAgICBjb25zdCByZXR1cm5WYWx1ZSA9IHt9O1xuICAgIGZvciAoY29uc3QgZmllbGQgaW4gcGlwZWxpbmUpIHtcbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgcmV0dXJuVmFsdWVbYF9wXyR7ZmllbGR9YF0gPSBwaXBlbGluZVtmaWVsZF07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm5WYWx1ZVtmaWVsZF0gPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUFyZ3Moc2NoZW1hLCBwaXBlbGluZVtmaWVsZF0pO1xuICAgICAgfVxuXG4gICAgICBpZiAoZmllbGQgPT09ICdvYmplY3RJZCcpIHtcbiAgICAgICAgcmV0dXJuVmFsdWVbJ19pZCddID0gcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICBkZWxldGUgcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gJ2NyZWF0ZWRBdCcpIHtcbiAgICAgICAgcmV0dXJuVmFsdWVbJ19jcmVhdGVkX2F0J10gPSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgIGRlbGV0ZSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkID09PSAndXBkYXRlZEF0Jykge1xuICAgICAgICByZXR1cm5WYWx1ZVsnX3VwZGF0ZWRfYXQnXSA9IHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgZGVsZXRlIHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJldHVyblZhbHVlO1xuICB9XG5cbiAgLy8gVGhpcyBmdW5jdGlvbiBpcyBzbGlnaHRseSBkaWZmZXJlbnQgdGhhbiB0aGUgdHdvIGFib3ZlLiBNb25nb0RCICRncm91cCBhZ2dyZWdhdGUgbG9va3MgbGlrZTpcbiAgLy8gICAgIHsgJGdyb3VwOiB7IF9pZDogPGV4cHJlc3Npb24+LCA8ZmllbGQxPjogeyA8YWNjdW11bGF0b3IxPiA6IDxleHByZXNzaW9uMT4gfSwgLi4uIH0gfVxuICAvLyBUaGUgPGV4cHJlc3Npb24+IGNvdWxkIGJlIGEgY29sdW1uIG5hbWUsIHByZWZpeGVkIHdpdGggdGhlICckJyBjaGFyYWN0ZXIuIFdlJ2xsIGxvb2sgZm9yXG4gIC8vIHRoZXNlIDxleHByZXNzaW9uPiBhbmQgY2hlY2sgdG8gc2VlIGlmIGl0IGlzIGEgJ1BvaW50ZXInIG9yIGlmIGl0J3Mgb25lIG9mIGNyZWF0ZWRBdCxcbiAgLy8gdXBkYXRlZEF0IG9yIG9iamVjdElkIGFuZCBjaGFuZ2UgaXQgYWNjb3JkaW5nbHkuXG4gIF9wYXJzZUFnZ3JlZ2F0ZUdyb3VwQXJncyhzY2hlbWE6IGFueSwgcGlwZWxpbmU6IGFueSk6IGFueSB7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkocGlwZWxpbmUpKSB7XG4gICAgICByZXR1cm4gcGlwZWxpbmUubWFwKCh2YWx1ZSkgPT5cbiAgICAgICAgdGhpcy5fcGFyc2VBZ2dyZWdhdGVHcm91cEFyZ3Moc2NoZW1hLCB2YWx1ZSlcbiAgICAgICk7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgcGlwZWxpbmUgPT09ICdvYmplY3QnKSB7XG4gICAgICBjb25zdCByZXR1cm5WYWx1ZSA9IHt9O1xuICAgICAgZm9yIChjb25zdCBmaWVsZCBpbiBwaXBlbGluZSkge1xuICAgICAgICByZXR1cm5WYWx1ZVtmaWVsZF0gPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUdyb3VwQXJncyhcbiAgICAgICAgICBzY2hlbWEsXG4gICAgICAgICAgcGlwZWxpbmVbZmllbGRdXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gcmV0dXJuVmFsdWU7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgcGlwZWxpbmUgPT09ICdzdHJpbmcnKSB7XG4gICAgICBjb25zdCBmaWVsZCA9IHBpcGVsaW5lLnN1YnN0cmluZygxKTtcbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgcmV0dXJuIGAkX3BfJHtmaWVsZH1gO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PSAnY3JlYXRlZEF0Jykge1xuICAgICAgICByZXR1cm4gJyRfY3JlYXRlZF9hdCc7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkID09ICd1cGRhdGVkQXQnKSB7XG4gICAgICAgIHJldHVybiAnJF91cGRhdGVkX2F0JztcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHBpcGVsaW5lO1xuICB9XG5cbiAgLy8gVGhpcyBmdW5jdGlvbiB3aWxsIGF0dGVtcHQgdG8gY29udmVydCB0aGUgcHJvdmlkZWQgdmFsdWUgdG8gYSBEYXRlIG9iamVjdC4gU2luY2UgdGhpcyBpcyBwYXJ0XG4gIC8vIG9mIGFuIGFnZ3JlZ2F0aW9uIHBpcGVsaW5lLCB0aGUgdmFsdWUgY2FuIGVpdGhlciBiZSBhIHN0cmluZyBvciBpdCBjYW4gYmUgYW5vdGhlciBvYmplY3Qgd2l0aFxuICAvLyBhbiBvcGVyYXRvciBpbiBpdCAobGlrZSAkZ3QsICRsdCwgZXRjKS4gQmVjYXVzZSBvZiB0aGlzIEkgZmVsdCBpdCB3YXMgZWFzaWVyIHRvIG1ha2UgdGhpcyBhXG4gIC8vIHJlY3Vyc2l2ZSBtZXRob2QgdG8gdHJhdmVyc2UgZG93biB0byB0aGUgXCJsZWFmIG5vZGVcIiB3aGljaCBpcyBnb2luZyB0byBiZSB0aGUgc3RyaW5nLlxuICBfY29udmVydFRvRGF0ZSh2YWx1ZTogYW55KTogYW55IHtcbiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgcmV0dXJuIG5ldyBEYXRlKHZhbHVlKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXR1cm5WYWx1ZSA9IHt9O1xuICAgIGZvciAoY29uc3QgZmllbGQgaW4gdmFsdWUpIHtcbiAgICAgIHJldHVyblZhbHVlW2ZpZWxkXSA9IHRoaXMuX2NvbnZlcnRUb0RhdGUodmFsdWVbZmllbGRdKTtcbiAgICB9XG4gICAgcmV0dXJuIHJldHVyblZhbHVlO1xuICB9XG5cbiAgX3BhcnNlUmVhZFByZWZlcmVuY2UocmVhZFByZWZlcmVuY2U6ID9zdHJpbmcpOiA/c3RyaW5nIHtcbiAgICBpZiAocmVhZFByZWZlcmVuY2UpIHtcbiAgICAgIHJlYWRQcmVmZXJlbmNlID0gcmVhZFByZWZlcmVuY2UudG9VcHBlckNhc2UoKTtcbiAgICB9XG4gICAgc3dpdGNoIChyZWFkUHJlZmVyZW5jZSkge1xuICAgICAgY2FzZSAnUFJJTUFSWSc6XG4gICAgICAgIHJlYWRQcmVmZXJlbmNlID0gUmVhZFByZWZlcmVuY2UuUFJJTUFSWTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdQUklNQVJZX1BSRUZFUlJFRCc6XG4gICAgICAgIHJlYWRQcmVmZXJlbmNlID0gUmVhZFByZWZlcmVuY2UuUFJJTUFSWV9QUkVGRVJSRUQ7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnU0VDT05EQVJZJzpcbiAgICAgICAgcmVhZFByZWZlcmVuY2UgPSBSZWFkUHJlZmVyZW5jZS5TRUNPTkRBUlk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnU0VDT05EQVJZX1BSRUZFUlJFRCc6XG4gICAgICAgIHJlYWRQcmVmZXJlbmNlID0gUmVhZFByZWZlcmVuY2UuU0VDT05EQVJZX1BSRUZFUlJFRDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdORUFSRVNUJzpcbiAgICAgICAgcmVhZFByZWZlcmVuY2UgPSBSZWFkUHJlZmVyZW5jZS5ORUFSRVNUO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgdW5kZWZpbmVkOlxuICAgICAgY2FzZSBudWxsOlxuICAgICAgY2FzZSAnJzpcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICAgICAnTm90IHN1cHBvcnRlZCByZWFkIHByZWZlcmVuY2UuJ1xuICAgICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gcmVhZFByZWZlcmVuY2U7XG4gIH1cblxuICBwZXJmb3JtSW5pdGlhbGl6YXRpb24oKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgY3JlYXRlSW5kZXgoY2xhc3NOYW1lOiBzdHJpbmcsIGluZGV4OiBhbnkpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKChjb2xsZWN0aW9uKSA9PiBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uY3JlYXRlSW5kZXgoaW5kZXgpKVxuICAgICAgLmNhdGNoKChlcnIpID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBjcmVhdGVJbmRleGVzKGNsYXNzTmFtZTogc3RyaW5nLCBpbmRleGVzOiBhbnkpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKChjb2xsZWN0aW9uKSA9PiBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uY3JlYXRlSW5kZXhlcyhpbmRleGVzKSlcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgY3JlYXRlSW5kZXhlc0lmTmVlZGVkKGNsYXNzTmFtZTogc3RyaW5nLCBmaWVsZE5hbWU6IHN0cmluZywgdHlwZTogYW55KSB7XG4gICAgaWYgKHR5cGUgJiYgdHlwZS50eXBlID09PSAnUG9seWdvbicpIHtcbiAgICAgIGNvbnN0IGluZGV4ID0ge1xuICAgICAgICBbZmllbGROYW1lXTogJzJkc3BoZXJlJyxcbiAgICAgIH07XG4gICAgICByZXR1cm4gdGhpcy5jcmVhdGVJbmRleChjbGFzc05hbWUsIGluZGV4KTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgY3JlYXRlVGV4dEluZGV4ZXNJZk5lZWRlZChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHNjaGVtYTogYW55XG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGZvciAoY29uc3QgZmllbGROYW1lIGluIHF1ZXJ5KSB7XG4gICAgICBpZiAoIXF1ZXJ5W2ZpZWxkTmFtZV0gfHwgIXF1ZXJ5W2ZpZWxkTmFtZV0uJHRleHQpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBleGlzdGluZ0luZGV4ZXMgPSBzY2hlbWEuaW5kZXhlcztcbiAgICAgIGZvciAoY29uc3Qga2V5IGluIGV4aXN0aW5nSW5kZXhlcykge1xuICAgICAgICBjb25zdCBpbmRleCA9IGV4aXN0aW5nSW5kZXhlc1trZXldO1xuICAgICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGluZGV4LCBmaWVsZE5hbWUpKSB7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBjb25zdCBpbmRleE5hbWUgPSBgJHtmaWVsZE5hbWV9X3RleHRgO1xuICAgICAgY29uc3QgdGV4dEluZGV4ID0ge1xuICAgICAgICBbaW5kZXhOYW1lXTogeyBbZmllbGROYW1lXTogJ3RleHQnIH0sXG4gICAgICB9O1xuICAgICAgcmV0dXJuIHRoaXMuc2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQoXG4gICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgdGV4dEluZGV4LFxuICAgICAgICBleGlzdGluZ0luZGV4ZXMsXG4gICAgICAgIHNjaGVtYS5maWVsZHNcbiAgICAgICkuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSA4NSkge1xuICAgICAgICAgIC8vIEluZGV4IGV4aXN0IHdpdGggZGlmZmVyZW50IG9wdGlvbnNcbiAgICAgICAgICByZXR1cm4gdGhpcy5zZXRJbmRleGVzRnJvbU1vbmdvKGNsYXNzTmFtZSk7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgZ2V0SW5kZXhlcyhjbGFzc05hbWU6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oKGNvbGxlY3Rpb24pID0+IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5pbmRleGVzKCkpXG4gICAgICAuY2F0Y2goKGVycikgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGRyb3BJbmRleChjbGFzc05hbWU6IHN0cmluZywgaW5kZXg6IGFueSkge1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oKGNvbGxlY3Rpb24pID0+IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5kcm9wSW5kZXgoaW5kZXgpKVxuICAgICAgLmNhdGNoKChlcnIpID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBkcm9wQWxsSW5kZXhlcyhjbGFzc05hbWU6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oKGNvbGxlY3Rpb24pID0+IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5kcm9wSW5kZXhlcygpKVxuICAgICAgLmNhdGNoKChlcnIpID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICB1cGRhdGVTY2hlbWFXaXRoSW5kZXhlcygpOiBQcm9taXNlPGFueT4ge1xuICAgIHJldHVybiB0aGlzLmdldEFsbENsYXNzZXMoKVxuICAgICAgLnRoZW4oKGNsYXNzZXMpID0+IHtcbiAgICAgICAgY29uc3QgcHJvbWlzZXMgPSBjbGFzc2VzLm1hcCgoc2NoZW1hKSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMuc2V0SW5kZXhlc0Zyb21Nb25nbyhzY2hlbWEuY2xhc3NOYW1lKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiBQcm9taXNlLmFsbChwcm9taXNlcyk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnIpID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBjcmVhdGVUcmFuc2FjdGlvbmFsU2Vzc2lvbigpOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IHRyYW5zYWN0aW9uYWxTZWN0aW9uID0gdGhpcy5jbGllbnQuc3RhcnRTZXNzaW9uKCk7XG4gICAgdHJhbnNhY3Rpb25hbFNlY3Rpb24uc3RhcnRUcmFuc2FjdGlvbigpO1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUodHJhbnNhY3Rpb25hbFNlY3Rpb24pO1xuICB9XG5cbiAgY29tbWl0VHJhbnNhY3Rpb25hbFNlc3Npb24odHJhbnNhY3Rpb25hbFNlY3Rpb246IGFueSk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiB0cmFuc2FjdGlvbmFsU2VjdGlvbi5jb21taXRUcmFuc2FjdGlvbigpLnRoZW4oKCkgPT4ge1xuICAgICAgdHJhbnNhY3Rpb25hbFNlY3Rpb24uZW5kU2Vzc2lvbigpO1xuICAgIH0pO1xuICB9XG5cbiAgYWJvcnRUcmFuc2FjdGlvbmFsU2Vzc2lvbih0cmFuc2FjdGlvbmFsU2VjdGlvbjogYW55KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIHRyYW5zYWN0aW9uYWxTZWN0aW9uLmFib3J0VHJhbnNhY3Rpb24oKS50aGVuKCgpID0+IHtcbiAgICAgIHRyYW5zYWN0aW9uYWxTZWN0aW9uLmVuZFNlc3Npb24oKTtcbiAgICB9KTtcbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBNb25nb1N0b3JhZ2VBZGFwdGVyO1xuIl19