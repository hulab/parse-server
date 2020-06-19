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
      insertOne
    }) => {
      return updateOne ? {
        updateOne: {
          filter: (0, _MongoTransform.transformWhere)(className, updateOne.filter, schema),
          update: (0, _MongoTransform.transformUpdate)(className, updateOne.update, schema),
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
    }, {});

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

  ensureIndex(className, schema, fieldNames, indexName, caseInsensitive = false, indexType = 1) {
    schema = convertParseSchemaToMongoSchema(schema);
    const indexCreationRequest = {};
    const mongoFieldNames = fieldNames.map(fieldName => (0, _MongoTransform.transformKey)(className, fieldName, schema));
    mongoFieldNames.forEach(fieldName => {
      indexCreationRequest[fieldName] = indexType;
    });
    const defaultOptions = {
      background: true,
      sparse: true
    };
    const indexNameOptions = indexName ? {
      name: indexName
    } : {};
    const caseInsensitiveOptions = caseInsensitive ? {
      collation: _MongoCollection.default.caseInsensitiveCollation()
    } : {};

    const indexOptions = _objectSpread({}, defaultOptions, {}, caseInsensitiveOptions, {}, indexNameOptions);

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9BZGFwdGVycy9TdG9yYWdlL01vbmdvL01vbmdvU3RvcmFnZUFkYXB0ZXIuanMiXSwibmFtZXMiOlsibW9uZ29kYiIsInJlcXVpcmUiLCJNb25nb0NsaWVudCIsIlJlYWRQcmVmZXJlbmNlIiwiTW9uZ29TY2hlbWFDb2xsZWN0aW9uTmFtZSIsInN0b3JhZ2VBZGFwdGVyQWxsQ29sbGVjdGlvbnMiLCJtb25nb0FkYXB0ZXIiLCJjb25uZWN0IiwidGhlbiIsImRhdGFiYXNlIiwiY29sbGVjdGlvbnMiLCJmaWx0ZXIiLCJjb2xsZWN0aW9uIiwibmFtZXNwYWNlIiwibWF0Y2giLCJjb2xsZWN0aW9uTmFtZSIsImluZGV4T2YiLCJfY29sbGVjdGlvblByZWZpeCIsImNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEiLCJzY2hlbWEiLCJmaWVsZHMiLCJfcnBlcm0iLCJfd3Blcm0iLCJjbGFzc05hbWUiLCJfaGFzaGVkX3Bhc3N3b3JkIiwibW9uZ29TY2hlbWFGcm9tRmllbGRzQW5kQ2xhc3NOYW1lQW5kQ0xQIiwiY2xhc3NMZXZlbFBlcm1pc3Npb25zIiwiaW5kZXhlcyIsIm1vbmdvT2JqZWN0IiwiX2lkIiwib2JqZWN0SWQiLCJ1cGRhdGVkQXQiLCJjcmVhdGVkQXQiLCJfbWV0YWRhdGEiLCJ1bmRlZmluZWQiLCJmaWVsZE5hbWUiLCJ0eXBlIiwidGFyZ2V0Q2xhc3MiLCJmaWVsZE9wdGlvbnMiLCJNb25nb1NjaGVtYUNvbGxlY3Rpb24iLCJwYXJzZUZpZWxkVHlwZVRvTW9uZ29GaWVsZFR5cGUiLCJPYmplY3QiLCJrZXlzIiwibGVuZ3RoIiwiZmllbGRzX29wdGlvbnMiLCJjbGFzc19wZXJtaXNzaW9ucyIsIk1vbmdvU3RvcmFnZUFkYXB0ZXIiLCJjb25zdHJ1Y3RvciIsInVyaSIsImRlZmF1bHRzIiwiRGVmYXVsdE1vbmdvVVJJIiwiY29sbGVjdGlvblByZWZpeCIsIm1vbmdvT3B0aW9ucyIsIl91cmkiLCJfbW9uZ29PcHRpb25zIiwidXNlTmV3VXJsUGFyc2VyIiwidXNlVW5pZmllZFRvcG9sb2d5IiwiX29uY2hhbmdlIiwiX21heFRpbWVNUyIsIm1heFRpbWVNUyIsImNhblNvcnRPbkpvaW5UYWJsZXMiLCJ3YXRjaCIsImNhbGxiYWNrIiwiY29ubmVjdGlvblByb21pc2UiLCJlbmNvZGVkVXJpIiwiY2xpZW50Iiwib3B0aW9ucyIsInMiLCJkYiIsImRiTmFtZSIsIm9uIiwiY2F0Y2giLCJlcnIiLCJQcm9taXNlIiwicmVqZWN0IiwiaGFuZGxlRXJyb3IiLCJlcnJvciIsImNvZGUiLCJsb2dnZXIiLCJoYW5kbGVTaHV0ZG93biIsInJlc29sdmUiLCJjbG9zZSIsIl9hZGFwdGl2ZUNvbGxlY3Rpb24iLCJuYW1lIiwicmF3Q29sbGVjdGlvbiIsIk1vbmdvQ29sbGVjdGlvbiIsIl9zY2hlbWFDb2xsZWN0aW9uIiwiX3N0cmVhbSIsIl9tb25nb0NvbGxlY3Rpb24iLCJjbGFzc0V4aXN0cyIsImxpc3RDb2xsZWN0aW9ucyIsInRvQXJyYXkiLCJzZXRDbGFzc0xldmVsUGVybWlzc2lvbnMiLCJDTFBzIiwic2NoZW1hQ29sbGVjdGlvbiIsInVwZGF0ZVNjaGVtYSIsIiRzZXQiLCJzZXRJbmRleGVzV2l0aFNjaGVtYUZvcm1hdCIsInN1Ym1pdHRlZEluZGV4ZXMiLCJleGlzdGluZ0luZGV4ZXMiLCJfaWRfIiwiZGVsZXRlUHJvbWlzZXMiLCJpbnNlcnRlZEluZGV4ZXMiLCJmb3JFYWNoIiwiZmllbGQiLCJfX29wIiwiUGFyc2UiLCJFcnJvciIsIklOVkFMSURfUVVFUlkiLCJwcm9taXNlIiwiZHJvcEluZGV4IiwicHVzaCIsImtleSIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsImluc2VydFByb21pc2UiLCJjcmVhdGVJbmRleGVzIiwiYWxsIiwic2V0SW5kZXhlc0Zyb21Nb25nbyIsImdldEluZGV4ZXMiLCJyZWR1Y2UiLCJvYmoiLCJpbmRleCIsIl9mdHMiLCJfZnRzeCIsIndlaWdodHMiLCJjcmVhdGVDbGFzcyIsImluc2VydFNjaGVtYSIsImFkZEZpZWxkSWZOb3RFeGlzdHMiLCJjcmVhdGVJbmRleGVzSWZOZWVkZWQiLCJkZWxldGVDbGFzcyIsImRyb3AiLCJtZXNzYWdlIiwiZmluZEFuZERlbGV0ZVNjaGVtYSIsImRlbGV0ZUFsbENsYXNzZXMiLCJmYXN0IiwibWFwIiwiZGVsZXRlTWFueSIsImRlbGV0ZUZpZWxkcyIsImZpZWxkTmFtZXMiLCJtb25nb0Zvcm1hdE5hbWVzIiwiY29sbGVjdGlvblVwZGF0ZSIsIiR1bnNldCIsInNjaGVtYVVwZGF0ZSIsInVwZGF0ZU1hbnkiLCJnZXRBbGxDbGFzc2VzIiwic2NoZW1hc0NvbGxlY3Rpb24iLCJfZmV0Y2hBbGxTY2hlbWFzRnJvbV9TQ0hFTUEiLCJnZXRDbGFzcyIsIl9mZXRjaE9uZVNjaGVtYUZyb21fU0NIRU1BIiwiY3JlYXRlT2JqZWN0Iiwib2JqZWN0IiwidHJhbnNhY3Rpb25hbFNlc3Npb24iLCJpbnNlcnRPbmUiLCJEVVBMSUNBVEVfVkFMVUUiLCJ1bmRlcmx5aW5nRXJyb3IiLCJtYXRjaGVzIiwiQXJyYXkiLCJpc0FycmF5IiwidXNlckluZm8iLCJkdXBsaWNhdGVkX2ZpZWxkIiwiY3JlYXRlT2JqZWN0cyIsIm9iamVjdHMiLCJtb25nb09iamVjdHMiLCJpbnNlcnRNYW55IiwiZGVsZXRlT2JqZWN0c0J5UXVlcnkiLCJxdWVyeSIsIm1vbmdvV2hlcmUiLCJyZXN1bHQiLCJuIiwiT0JKRUNUX05PVF9GT1VORCIsIklOVEVSTkFMX1NFUlZFUl9FUlJPUiIsInVwZGF0ZU9iamVjdHNCeVF1ZXJ5IiwidXBkYXRlIiwibW9uZ29VcGRhdGUiLCJmaW5kT25lQW5kVXBkYXRlIiwicmV0dXJuT3JpZ2luYWwiLCJzZXNzaW9uIiwidmFsdWUiLCJ1cGRhdGVPYmplY3RzQnlCdWxrIiwib3BlcmF0aW9ucyIsImJ1bGtzIiwidXBkYXRlT25lIiwidXBzZXJ0IiwiZG9jdW1lbnQiLCJidWxrV3JpdGUiLCJ1cHNlcnRPbmVPYmplY3QiLCJ1cHNlcnRPbmUiLCJmaW5kIiwic2tpcCIsImxpbWl0Iiwic29ydCIsInJlYWRQcmVmZXJlbmNlIiwiaGludCIsImNhc2VJbnNlbnNpdGl2ZSIsImV4cGxhaW4iLCJtb25nb1NvcnQiLCJfIiwibWFwS2V5cyIsIm1vbmdvS2V5cyIsIm1lbW8iLCJfcGFyc2VSZWFkUHJlZmVyZW5jZSIsImNyZWF0ZVRleHRJbmRleGVzSWZOZWVkZWQiLCJlbnN1cmVJbmRleCIsImluZGV4TmFtZSIsImluZGV4VHlwZSIsImluZGV4Q3JlYXRpb25SZXF1ZXN0IiwibW9uZ29GaWVsZE5hbWVzIiwiZGVmYXVsdE9wdGlvbnMiLCJiYWNrZ3JvdW5kIiwic3BhcnNlIiwiaW5kZXhOYW1lT3B0aW9ucyIsImNhc2VJbnNlbnNpdGl2ZU9wdGlvbnMiLCJjb2xsYXRpb24iLCJjYXNlSW5zZW5zaXRpdmVDb2xsYXRpb24iLCJpbmRleE9wdGlvbnMiLCJjcmVhdGVJbmRleCIsImVuc3VyZVVuaXF1ZW5lc3MiLCJfZW5zdXJlU3BhcnNlVW5pcXVlSW5kZXhJbkJhY2tncm91bmQiLCJfcmF3RmluZCIsImNvdW50IiwiZGlzdGluY3QiLCJpc1BvaW50ZXJGaWVsZCIsInRyYW5zZm9ybUZpZWxkIiwiYWdncmVnYXRlIiwicGlwZWxpbmUiLCJzdGFnZSIsIiRncm91cCIsIl9wYXJzZUFnZ3JlZ2F0ZUdyb3VwQXJncyIsIiRtYXRjaCIsIl9wYXJzZUFnZ3JlZ2F0ZUFyZ3MiLCIkcHJvamVjdCIsIl9wYXJzZUFnZ3JlZ2F0ZVByb2plY3RBcmdzIiwiJGdlb05lYXIiLCJyZXN1bHRzIiwic3BsaXQiLCJpbmNsdWRlcyIsImlzRW1wdHkiLCJEYXRlIiwicmV0dXJuVmFsdWUiLCJfY29udmVydFRvRGF0ZSIsIl9fdHlwZSIsImlzbyIsInN1YnN0cmluZyIsInRvVXBwZXJDYXNlIiwiUFJJTUFSWSIsIlBSSU1BUllfUFJFRkVSUkVEIiwiU0VDT05EQVJZIiwiU0VDT05EQVJZX1BSRUZFUlJFRCIsIk5FQVJFU1QiLCJwZXJmb3JtSW5pdGlhbGl6YXRpb24iLCIkdGV4dCIsInRleHRJbmRleCIsImRyb3BBbGxJbmRleGVzIiwiZHJvcEluZGV4ZXMiLCJ1cGRhdGVTY2hlbWFXaXRoSW5kZXhlcyIsImNsYXNzZXMiLCJwcm9taXNlcyIsImNyZWF0ZVRyYW5zYWN0aW9uYWxTZXNzaW9uIiwidHJhbnNhY3Rpb25hbFNlY3Rpb24iLCJzdGFydFNlc3Npb24iLCJzdGFydFRyYW5zYWN0aW9uIiwiY29tbWl0VHJhbnNhY3Rpb25hbFNlc3Npb24iLCJjb21taXRUcmFuc2FjdGlvbiIsImVuZFNlc3Npb24iLCJhYm9ydFRyYW5zYWN0aW9uYWxTZXNzaW9uIiwiYWJvcnRUcmFuc2FjdGlvbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7OztBQUNBOztBQUNBOztBQUNBOztBQU9BOztBQUlBOztBQVNBOztBQUVBOztBQUNBOztBQUNBOzs7Ozs7Ozs7Ozs7Ozs7O0FBRUE7QUFDQSxNQUFNQSxPQUFPLEdBQUdDLE9BQU8sQ0FBQyxTQUFELENBQXZCOztBQUNBLE1BQU1DLFdBQVcsR0FBR0YsT0FBTyxDQUFDRSxXQUE1QjtBQUNBLE1BQU1DLGNBQWMsR0FBR0gsT0FBTyxDQUFDRyxjQUEvQjtBQUVBLE1BQU1DLHlCQUF5QixHQUFHLFNBQWxDOztBQUVBLE1BQU1DLDRCQUE0QixHQUFHQyxZQUFZLElBQUk7QUFDbkQsU0FBT0EsWUFBWSxDQUNoQkMsT0FESSxHQUVKQyxJQUZJLENBRUMsTUFBTUYsWUFBWSxDQUFDRyxRQUFiLENBQXNCQyxXQUF0QixFQUZQLEVBR0pGLElBSEksQ0FHQ0UsV0FBVyxJQUFJO0FBQ25CLFdBQU9BLFdBQVcsQ0FBQ0MsTUFBWixDQUFtQkMsVUFBVSxJQUFJO0FBQ3RDLFVBQUlBLFVBQVUsQ0FBQ0MsU0FBWCxDQUFxQkMsS0FBckIsQ0FBMkIsWUFBM0IsQ0FBSixFQUE4QztBQUM1QyxlQUFPLEtBQVA7QUFDRCxPQUhxQyxDQUl0QztBQUNBOzs7QUFDQSxhQUNFRixVQUFVLENBQUNHLGNBQVgsQ0FBMEJDLE9BQTFCLENBQWtDVixZQUFZLENBQUNXLGlCQUEvQyxLQUFxRSxDQUR2RTtB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QU8sQ0FBQzZDLEdBQVIsQ0FBWTRJLFFBQVosQ0FBUDtBQUNELEtBTkksRUFPSjNMLEtBUEksQ0FPRUMsR0FBRyxJQUFJLEtBQUtHLFdBQUwsQ0FBaUJILEdBQWpCLENBUFQsQ0FBUDtBQVFEOztBQUVEMkwsRUFBQUEsMEJBQTBCLEdBQWlCO0FBQ3pDLFVBQU1DLG9CQUFvQixHQUFHLEtBQUtuTSxNQUFMLENBQVlvTSxZQUFaLEVBQTdCO0FBQ0FELElBQUFBLG9CQUFvQixDQUFDRSxnQkFBckI7QUFDQSxXQUFPN0wsT0FBTyxDQUFDTyxPQUFSLENBQWdCb0wsb0JBQWhCLENBQVA7QUFDRDs7QUFFREcsRUFBQUEsMEJBQTBCLENBQUNILG9CQUFELEVBQTJDO0FBQ25FLFdBQU9BLG9CQUFvQixDQUFDSSxpQkFBckIsR0FBeUNoUSxJQUF6QyxDQUE4QyxNQUFNO0FBQ3pENFAsTUFBQUEsb0JBQW9CLENBQUNLLFVBQXJCO0FBQ0QsS0FGTSxDQUFQO0FBR0Q7O0FBRURDLEVBQUFBLHlCQUF5QixDQUFDTixvQkFBRCxFQUEyQztBQUNsRSxXQUFPQSxvQkFBb0IsQ0FBQ08sZ0JBQXJCLEdBQXdDblEsSUFBeEMsQ0FBNkMsTUFBTTtBQUN4RDRQLE1BQUFBLG9CQUFvQixDQUFDSyxVQUFyQjtBQUNELEtBRk0sQ0FBUDtBQUdEOztBQS9tQ3dEOzs7ZUFrbkM1QzNOLG1CIiwic291cmNlc0NvbnRlbnQiOlsiLy8gQGZsb3dcbmltcG9ydCBNb25nb0NvbGxlY3Rpb24gZnJvbSAnLi9Nb25nb0NvbGxlY3Rpb24nO1xuaW1wb3J0IE1vbmdvU2NoZW1hQ29sbGVjdGlvbiBmcm9tICcuL01vbmdvU2NoZW1hQ29sbGVjdGlvbic7XG5pbXBvcnQgeyBTdG9yYWdlQWRhcHRlciB9IGZyb20gJy4uL1N0b3JhZ2VBZGFwdGVyJztcbmltcG9ydCB0eXBlIHtcbiAgU2NoZW1hVHlwZSxcbiAgUXVlcnlUeXBlLFxuICBTdG9yYWdlQ2xhc3MsXG4gIFF1ZXJ5T3B0aW9ucyxcbn0gZnJvbSAnLi4vU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IHtcbiAgcGFyc2UgYXMgcGFyc2VVcmwsXG4gIGZvcm1hdCBhcyBmb3JtYXRVcmwsXG59IGZyb20gJy4uLy4uLy4uL3ZlbmRvci9tb25nb2RiVXJsJztcbmltcG9ydCB7XG4gIHBhcnNlT2JqZWN0VG9Nb25nb09iamVjdEZvckNyZWF0ZSxcbiAgbW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0LFxuICB0cmFuc2Zvcm1LZXksXG4gIHRyYW5zZm9ybVdoZXJlLFxuICB0cmFuc2Zvcm1VcGRhdGUsXG4gIHRyYW5zZm9ybVBvaW50ZXJTdHJpbmcsXG59IGZyb20gJy4vTW9uZ29UcmFuc2Zvcm0nO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgUGFyc2UgZnJvbSAncGFyc2Uvbm9kZSc7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG5pbXBvcnQgZGVmYXVsdHMgZnJvbSAnLi4vLi4vLi4vZGVmYXVsdHMnO1xuaW1wb3J0IGxvZ2dlciBmcm9tICcuLi8uLi8uLi9sb2dnZXInO1xuXG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmNvbnN0IG1vbmdvZGIgPSByZXF1aXJlKCdtb25nb2RiJyk7XG5jb25zdCBNb25nb0NsaWVudCA9IG1vbmdvZGIuTW9uZ29DbGllbnQ7XG5jb25zdCBSZWFkUHJlZmVyZW5jZSA9IG1vbmdvZGIuUmVhZFByZWZlcmVuY2U7XG5cbmNvbnN0IE1vbmdvU2NoZW1hQ29sbGVjdGlvbk5hbWUgPSAnX1NDSEVNQSc7XG5cbmNvbnN0IHN0b3JhZ2VBZGFwdGVyQWxsQ29sbGVjdGlvbnMgPSBtb25nb0FkYXB0ZXIgPT4ge1xuICByZXR1cm4gbW9uZ29BZGFwdGVyXG4gICAgLmNvbm5lY3QoKVxuICAgIC50aGVuKCgpID0+IG1vbmdvQWRhcHRlci5kYXRhYmFzZS5jb2xsZWN0aW9ucygpKVxuICAgIC50aGVuKGNvbGxlY3Rpb25zID0+IHtcbiAgICAgIHJldHVybiBjb2xsZWN0aW9ucy5maWx0ZXIoY29sbGVjdGlvbiA9PiB7XG4gICAgICAgIGlmIChjb2xsZWN0aW9uLm5hbWVzcGFjZS5tYXRjaCgvXFwuc3lzdGVtXFwuLykpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgLy8gVE9ETzogSWYgeW91IGhhdmUgb25lIGFwcCB3aXRoIGEgY29sbGVjdGlvbiBwcmVmaXggdGhhdCBoYXBwZW5zIHRvIGJlIGEgcHJlZml4IG9mIGFub3RoZXJcbiAgICAgICAgLy8gYXBwcyBwcmVmaXgsIHRoaXMgd2lsbCBnbyB2ZXJ5IHZlcnkgYmFkbHkuIFdlIHNob3VsZCBmaXggdGhhdCBzb21laG93LlxuICAgICAgICByZXR1cm4gKFxuICAgICAgICAgIGNvbGxlY3Rpb24uY29sbGVjdGlvbk5hbWUuaW5kZXhPZihtb25nb0FkYXB0ZXIuX2NvbGxlY3Rpb25QcmVmaXgpID09IDBcbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICAgIH0pO1xufTtcblxuY29uc3QgY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYSA9ICh7IC4uLnNjaGVtYSB9KSA9PiB7XG4gIGRlbGV0ZSBzY2hlbWEuZmllbGRzLl9ycGVybTtcbiAgZGVsZXRlIHNjaGVtYS5maWVsZHMuX3dwZXJtO1xuXG4gIGlmIChzY2hlbWEuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgLy8gTGVnYWN5IG1vbmdvIGFkYXB0ZXIga25vd3MgYWJvdXQgdGhlIGRpZmZlcmVuY2UgYmV0d2VlbiBwYXNzd29yZCBhbmQgX2hhc2hlZF9wYXNzd29yZC5cbiAgICAvLyBGdXR1cmUgZGF0YWJhc2UgYWRhcHRlcnMgd2lsbCBvbmx5IGtub3cgYWJvdXQgX2hhc2hlZF9wYXNzd29yZC5cbiAgICAvLyBOb3RlOiBQYXJzZSBTZXJ2ZXIgd2lsbCBicmluZyBiYWNrIHBhc3N3b3JkIHdpdGggaW5qZWN0RGVmYXVsdFNjaGVtYSwgc28gd2UgZG9uJ3QgbmVlZFxuICAgIC8vIHRvIGFkZCBfaGFzaGVkX3Bhc3N3b3JkIGJhY2sgZXZlci5cbiAgICBkZWxldGUgc2NoZW1hLmZpZWxkcy5faGFzaGVkX3Bhc3N3b3JkO1xuICB9XG5cbiAgcmV0dXJuIHNjaGVtYTtcbn07XG5cbi8vIFJldHVybnMgeyBjb2RlLCBlcnJvciB9IGlmIGludmFsaWQsIG9yIHsgcmVzdWx0IH0sIGFuIG9iamVjdFxuLy8gc3VpdGFibGUgZm9yIGluc2VydGluZyBpbnRvIF9TQ0hFTUEgY29sbGVjdGlvbiwgb3RoZXJ3aXNlLlxuY29uc3QgbW9uZ29TY2hlbWFGcm9tRmllbGRzQW5kQ2xhc3NOYW1lQW5kQ0xQID0gKFxuICBmaWVsZHMsXG4gIGNsYXNzTmFtZSxcbiAgY2xhc3NMZXZlbFBlcm1pc3Npb25zLFxuICBpbmRleGVzXG4pID0+IHtcbiAgY29uc3QgbW9uZ29PYmplY3QgPSB7XG4gICAgX2lkOiBjbGFzc05hbWUsXG4gICAgb2JqZWN0SWQ6ICdzdHJpbmcnLFxuICAgIHVwZGF0ZWRBdDogJ3N0cmluZycsXG4gICAgY3JlYXRlZEF0OiAnc3RyaW5nJyxcbiAgICBfbWV0YWRhdGE6IHVuZGVmaW5lZCxcbiAgfTtcblxuICBmb3IgKGNvbnN0IGZpZWxkTmFtZSBpbiBmaWVsZHMpIHtcbiAgICBjb25zdCB7IHR5cGUsIHRhcmdldENsYXNzLCAuLi5maWVsZE9wdGlvbnMgfSA9IGZpZWxkc1tmaWVsZE5hbWVdO1xuICAgIG1vbmdvT2JqZWN0W1xuICAgICAgZmllbGROYW1lXG4gICAgXSA9IE1vbmdvU2NoZW1hQ29sbGVjdGlvbi5wYXJzZUZpZWxkVHlwZVRvTW9uZ29GaWVsZFR5cGUoe1xuICAgICAgdHlwZSxcbiAgICAgIHRhcmdldENsYXNzLFxuICAgIH0pO1xuICAgIGlmIChmaWVsZE9wdGlvbnMgJiYgT2JqZWN0LmtleXMoZmllbGRPcHRpb25zKS5sZW5ndGggPiAwKSB7XG4gICAgICBtb25nb09iamVjdC5fbWV0YWRhdGEgPSBtb25nb09iamVjdC5fbWV0YWRhdGEgfHwge307XG4gICAgICBtb25nb09iamVjdC5fbWV0YWRhdGEuZmllbGRzX29wdGlvbnMgPVxuICAgICAgICBtb25nb09iamVjdC5fbWV0YWRhdGEuZmllbGRzX29wdGlvbnMgfHwge307XG4gICAgICBtb25nb09iamVjdC5fbWV0YWRhdGEuZmllbGRzX29wdGlvbnNbZmllbGROYW1lXSA9IGZpZWxkT3B0aW9ucztcbiAgICB9XG4gIH1cblxuICBpZiAodHlwZW9mIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICBtb25nb09iamVjdC5fbWV0YWRhdGEgPSBtb25nb09iamVjdC5fbWV0YWRhdGEgfHwge307XG4gICAgaWYgKCFjbGFzc0xldmVsUGVybWlzc2lvbnMpIHtcbiAgICAgIGRlbGV0ZSBtb25nb09iamVjdC5fbWV0YWRhdGEuY2xhc3NfcGVybWlzc2lvbnM7XG4gICAgfSBlbHNlIHtcbiAgICAgIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YS5jbGFzc19wZXJtaXNzaW9ucyA9IGNsYXNzTGV2ZWxQZXJtaXNzaW9ucztcbiAgICB9XG4gIH1cblxuICBpZiAoXG4gICAgaW5kZXhlcyAmJlxuICAgIHR5cGVvZiBpbmRleGVzID09PSAnb2JqZWN0JyAmJlxuICAgIE9iamVjdC5rZXlzKGluZGV4ZXMpLmxlbmd0aCA+IDBcbiAgKSB7XG4gICAgbW9uZ29PYmplY3QuX21ldGFkYXRhID0gbW9uZ29PYmplY3QuX21ldGFkYXRhIHx8IHt9O1xuICAgIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YS5pbmRleGVzID0gaW5kZXhlcztcbiAgfVxuXG4gIGlmICghbW9uZ29PYmplY3QuX21ldGFkYXRhKSB7XG4gICAgLy8gY2xlYW51cCB0aGUgdW51c2VkIF9tZXRhZGF0YVxuICAgIGRlbGV0ZSBtb25nb09iamVjdC5fbWV0YWRhdGE7XG4gIH1cblxuICByZXR1cm4gbW9uZ29PYmplY3Q7XG59O1xuXG5leHBvcnQgY2xhc3MgTW9uZ29TdG9yYWdlQWRhcHRlciBpbXBsZW1lbnRzIFN0b3JhZ2VBZGFwdGVyIHtcbiAgLy8gUHJpdmF0ZVxuICBfdXJpOiBzdHJpbmc7XG4gIF9jb2xsZWN0aW9uUHJlZml4OiBzdHJpbmc7XG4gIF9tb25nb09wdGlvbnM6IE9iamVjdDtcbiAgX3N0cmVhbTogYW55O1xuICBfb25jaGFuZ2U6IGFueTtcbiAgLy8gUHVibGljXG4gIGNvbm5lY3Rpb25Qcm9taXNlOiA/UHJvbWlzZTxhbnk+O1xuICBkYXRhYmFzZTogYW55O1xuICBjbGllbnQ6IE1vbmdvQ2xpZW50O1xuICBfbWF4VGltZU1TOiA/bnVtYmVyO1xuICBjYW5Tb3J0T25Kb2luVGFibGVzOiBib29sZWFuO1xuXG4gIGNvbnN0cnVjdG9yKHtcbiAgICB1cmkgPSBkZWZhdWx0cy5EZWZhdWx0TW9uZ29VUkksXG4gICAgY29sbGVjdGlvblByZWZpeCA9ICcnLFxuICAgIG1vbmdvT3B0aW9ucyA9IHt9LFxuICB9OiBhbnkpIHtcbiAgICB0aGlzLl91cmkgPSB1cmk7XG4gICAgdGhpcy5fY29sbGVjdGlvblByZWZpeCA9IGNvbGxlY3Rpb25QcmVmaXg7XG4gICAgdGhpcy5fbW9uZ29PcHRpb25zID0gbW9uZ29PcHRpb25zO1xuICAgIHRoaXMuX21vbmdvT3B0aW9ucy51c2VOZXdVcmxQYXJzZXIgPSB0cnVlO1xuICAgIHRoaXMuX21vbmdvT3B0aW9ucy51c2VVbmlmaWVkVG9wb2xvZ3kgPSB0cnVlO1xuICAgIHRoaXMuX29uY2hhbmdlID0gKCkgPT4ge307XG5cbiAgICAvLyBNYXhUaW1lTVMgaXMgbm90IGEgZ2xvYmFsIE1vbmdvREIgY2xpZW50IG9wdGlvbiwgaXQgaXMgYXBwbGllZCBwZXIgb3BlcmF0aW9uLlxuICAgIHRoaXMuX21heFRpbWVNUyA9IG1vbmdvT3B0aW9ucy5tYXhUaW1lTVM7XG4gICAgdGhpcy5jYW5Tb3J0T25Kb2luVGFibGVzID0gdHJ1ZTtcbiAgICBkZWxldGUgbW9uZ29PcHRpb25zLm1heFRpbWVNUztcbiAgfVxuXG4gIHdhdGNoKGNhbGxiYWNrKSB7XG4gICAgdGhpcy5fb25jaGFuZ2UgPSBjYWxsYmFjaztcbiAgfVxuXG4gIGNvbm5lY3QoKSB7XG4gICAgaWYgKHRoaXMuY29ubmVjdGlvblByb21pc2UpIHtcbiAgICAgIHJldHVybiB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgIH1cblxuICAgIC8vIHBhcnNpbmcgYW5kIHJlLWZvcm1hdHRpbmcgY2F1c2VzIHRoZSBhdXRoIHZhbHVlIChpZiB0aGVyZSkgdG8gZ2V0IFVSSVxuICAgIC8vIGVuY29kZWRcbiAgICBjb25zdCBlbmNvZGVkVXJpID0gZm9ybWF0VXJsKHBhcnNlVXJsKHRoaXMuX3VyaSkpO1xuXG4gICAgdGhpcy5jb25uZWN0aW9uUHJvbWlzZSA9IE1vbmdvQ2xpZW50LmNvbm5lY3QoZW5jb2RlZFVyaSwgdGhpcy5fbW9uZ29PcHRpb25zKVxuICAgICAgLnRoZW4oY2xpZW50ID0+IHtcbiAgICAgICAgLy8gU3RhcnRpbmcgbW9uZ29EQiAzLjAsIHRoZSBNb25nb0NsaWVudC5jb25uZWN0IGRvbid0IHJldHVybiBhIERCIGFueW1vcmUgYnV0IGEgY2xpZW50XG4gICAgICAgIC8vIEZvcnR1bmF0ZWx5LCB3ZSBjYW4gZ2V0IGJhY2sgdGhlIG9wdGlvbnMgYW5kIHVzZSB0aGVtIHRvIHNlbGVjdCB0aGUgcHJvcGVyIERCLlxuICAgICAgICAvLyBodHRwczovL2dpdGh1Yi5jb20vbW9uZ29kYi9ub2RlLW1vbmdvZGItbmF0aXZlL2Jsb2IvMmMzNWQ3NmYwODU3NDIyNWI4ZGIwMmQ3YmVmNjg3MTIzZTZiYjAxOC9saWIvbW9uZ29fY2xpZW50LmpzI0w4ODVcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGNsaWVudC5zLm9wdGlvbnM7XG4gICAgICAgIGNvbnN0IGRhdGFiYXNlID0gY2xpZW50LmRiKG9wdGlvbnMuZGJOYW1lKTtcbiAgICAgICAgaWYgKCFkYXRhYmFzZSkge1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBkYXRhYmFzZS5vbignZXJyb3InLCAoKSA9PiB7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuY29ubmVjdGlvblByb21pc2U7XG4gICAgICAgIH0pO1xuICAgICAgICBkYXRhYmFzZS5vbignY2xvc2UnLCAoKSA9PiB7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuY29ubmVjdGlvblByb21pc2U7XG4gICAgICAgIH0pO1xuICAgICAgICB0aGlzLmNsaWVudCA9IGNsaWVudDtcbiAgICAgICAgdGhpcy5kYXRhYmFzZSA9IGRhdGFiYXNlO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4ge1xuICAgICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KGVycik7XG4gICAgICB9KTtcblxuICAgIHJldHVybiB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICB9XG5cbiAgaGFuZGxlRXJyb3I8VD4oZXJyb3I6ID8oRXJyb3IgfCBQYXJzZS5FcnJvcikpOiBQcm9taXNlPFQ+IHtcbiAgICBpZiAoZXJyb3IgJiYgZXJyb3IuY29kZSA9PT0gMTMpIHtcbiAgICAgIC8vIFVuYXV0aG9yaXplZCBlcnJvclxuICAgICAgZGVsZXRlIHRoaXMuY2xpZW50O1xuICAgICAgZGVsZXRlIHRoaXMuZGF0YWJhc2U7XG4gICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgIGxvZ2dlci5lcnJvcignUmVjZWl2ZWQgdW5hdXRob3JpemVkIGVycm9yJywgeyBlcnJvcjogZXJyb3IgfSk7XG4gICAgfVxuICAgIHRocm93IGVycm9yO1xuICB9XG5cbiAgaGFuZGxlU2h1dGRvd24oKSB7XG4gICAgaWYgKCF0aGlzLmNsaWVudCkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5jbGllbnQuY2xvc2UoZmFsc2UpO1xuICB9XG5cbiAgX2FkYXB0aXZlQ29sbGVjdGlvbihuYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5jb25uZWN0KClcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuZGF0YWJhc2UuY29sbGVjdGlvbih0aGlzLl9jb2xsZWN0aW9uUHJlZml4ICsgbmFtZSkpXG4gICAgICAudGhlbihyYXdDb2xsZWN0aW9uID0+IG5ldyBNb25nb0NvbGxlY3Rpb24ocmF3Q29sbGVjdGlvbikpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBfc2NoZW1hQ29sbGVjdGlvbigpOiBQcm9taXNlPE1vbmdvU2NoZW1hQ29sbGVjdGlvbj4ge1xuICAgIHJldHVybiB0aGlzLmNvbm5lY3QoKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKE1vbmdvU2NoZW1hQ29sbGVjdGlvbk5hbWUpKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiB7XG4gICAgICAgIGlmICghdGhpcy5fc3RyZWFtKSB7XG4gICAgICAgICAgdGhpcy5fc3RyZWFtID0gY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLndhdGNoKCk7XG4gICAgICAgICAgdGhpcy5fc3RyZWFtLm9uKCdjaGFuZ2UnLCB0aGlzLl9vbmNoYW5nZSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG5ldyBNb25nb1NjaGVtYUNvbGxlY3Rpb24oY29sbGVjdGlvbik7XG4gICAgICB9KTtcbiAgfVxuXG4gIGNsYXNzRXhpc3RzKG5hbWU6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLmNvbm5lY3QoKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gdGhpcy5kYXRhYmFzZVxuICAgICAgICAgIC5saXN0Q29sbGVjdGlvbnMoeyBuYW1lOiB0aGlzLl9jb2xsZWN0aW9uUHJlZml4ICsgbmFtZSB9KVxuICAgICAgICAgIC50b0FycmF5KCk7XG4gICAgICB9KVxuICAgICAgLnRoZW4oY29sbGVjdGlvbnMgPT4ge1xuICAgICAgICByZXR1cm4gY29sbGVjdGlvbnMubGVuZ3RoID4gMDtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBzZXRDbGFzc0xldmVsUGVybWlzc2lvbnMoY2xhc3NOYW1lOiBzdHJpbmcsIENMUHM6IGFueSk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKClcbiAgICAgIC50aGVuKHNjaGVtYUNvbGxlY3Rpb24gPT5cbiAgICAgICAgc2NoZW1hQ29sbGVjdGlvbi51cGRhdGVTY2hlbWEoY2xhc3NOYW1lLCB7XG4gICAgICAgICAgJHNldDogeyAnX21ldGFkYXRhLmNsYXNzX3Blcm1pc3Npb25zJzogQ0xQcyB9LFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgc2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc3VibWl0dGVkSW5kZXhlczogYW55LFxuICAgIGV4aXN0aW5nSW5kZXhlczogYW55ID0ge30sXG4gICAgZmllbGRzOiBhbnlcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHN1Ym1pdHRlZEluZGV4ZXMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIH1cbiAgICBpZiAoT2JqZWN0LmtleXMoZXhpc3RpbmdJbmRleGVzKS5sZW5ndGggPT09IDApIHtcbiAgICAgIGV4aXN0aW5nSW5kZXhlcyA9IHsgX2lkXzogeyBfaWQ6IDEgfSB9O1xuICAgIH1cbiAgICBjb25zdCBkZWxldGVQcm9taXNlcyA9IFtdO1xuICAgIGNvbnN0IGluc2VydGVkSW5kZXhlcyA9IFtdO1xuICAgIE9iamVjdC5rZXlzKHN1Ym1pdHRlZEluZGV4ZXMpLmZvckVhY2gobmFtZSA9PiB7XG4gICAgICBjb25zdCBmaWVsZCA9IHN1Ym1pdHRlZEluZGV4ZXNbbmFtZV07XG4gICAgICBpZiAoZXhpc3RpbmdJbmRleGVzW25hbWVdICYmIGZpZWxkLl9fb3AgIT09ICdEZWxldGUnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgIGBJbmRleCAke25hbWV9IGV4aXN0cywgY2Fubm90IHVwZGF0ZS5gXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoIWV4aXN0aW5nSW5kZXhlc1tuYW1lXSAmJiBmaWVsZC5fX29wID09PSAnRGVsZXRlJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICAgICBgSW5kZXggJHtuYW1lfSBkb2VzIG5vdCBleGlzdCwgY2Fubm90IGRlbGV0ZS5gXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoZmllbGQuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgY29uc3QgcHJvbWlzZSA9IHRoaXMuZHJvcEluZGV4KGNsYXNzTmFtZSwgbmFtZSk7XG4gICAgICAgIGRlbGV0ZVByb21pc2VzLnB1c2gocHJvbWlzZSk7XG4gICAgICAgIGRlbGV0ZSBleGlzdGluZ0luZGV4ZXNbbmFtZV07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBPYmplY3Qua2V5cyhmaWVsZCkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGZpZWxkcywga2V5KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgICAgICBgRmllbGQgJHtrZXl9IGRvZXMgbm90IGV4aXN0LCBjYW5ub3QgYWRkIGluZGV4LmBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgZXhpc3RpbmdJbmRleGVzW25hbWVdID0gZmllbGQ7XG4gICAgICAgIGluc2VydGVkSW5kZXhlcy5wdXNoKHtcbiAgICAgICAgICBrZXk6IGZpZWxkLFxuICAgICAgICAgIG5hbWUsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGxldCBpbnNlcnRQcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgaWYgKGluc2VydGVkSW5kZXhlcy5sZW5ndGggPiAwKSB7XG4gICAgICBpbnNlcnRQcm9taXNlID0gdGhpcy5jcmVhdGVJbmRleGVzKGNsYXNzTmFtZSwgaW5zZXJ0ZWRJbmRleGVzKTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UuYWxsKGRlbGV0ZVByb21pc2VzKVxuICAgICAgLnRoZW4oKCkgPT4gaW5zZXJ0UHJvbWlzZSlcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKSlcbiAgICAgIC50aGVuKHNjaGVtYUNvbGxlY3Rpb24gPT5cbiAgICAgICAgc2NoZW1hQ29sbGVjdGlvbi51cGRhdGVTY2hlbWEoY2xhc3NOYW1lLCB7XG4gICAgICAgICAgJHNldDogeyAnX21ldGFkYXRhLmluZGV4ZXMnOiBleGlzdGluZ0luZGV4ZXMgfSxcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIHNldEluZGV4ZXNGcm9tTW9uZ28oY2xhc3NOYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5nZXRJbmRleGVzKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGluZGV4ZXMgPT4ge1xuICAgICAgICBpbmRleGVzID0gaW5kZXhlcy5yZWR1Y2UoKG9iaiwgaW5kZXgpID0+IHtcbiAgICAgICAgICBpZiAoaW5kZXgua2V5Ll9mdHMpIHtcbiAgICAgICAgICAgIGRlbGV0ZSBpbmRleC5rZXkuX2Z0cztcbiAgICAgICAgICAgIGRlbGV0ZSBpbmRleC5rZXkuX2Z0c3g7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIGluZGV4LndlaWdodHMpIHtcbiAgICAgICAgICAgICAgaW5kZXgua2V5W2ZpZWxkXSA9ICd0ZXh0JztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgb2JqW2luZGV4Lm5hbWVdID0gaW5kZXgua2V5O1xuICAgICAgICAgIHJldHVybiBvYmo7XG4gICAgICAgIH0sIHt9KTtcbiAgICAgICAgcmV0dXJuIHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKS50aGVuKHNjaGVtYUNvbGxlY3Rpb24gPT5cbiAgICAgICAgICBzY2hlbWFDb2xsZWN0aW9uLnVwZGF0ZVNjaGVtYShjbGFzc05hbWUsIHtcbiAgICAgICAgICAgICRzZXQ6IHsgJ19tZXRhZGF0YS5pbmRleGVzJzogaW5kZXhlcyB9LFxuICAgICAgICAgIH0pXG4gICAgICAgICk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpXG4gICAgICAuY2F0Y2goKCkgPT4ge1xuICAgICAgICAvLyBJZ25vcmUgaWYgY29sbGVjdGlvbiBub3QgZm91bmRcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgfSk7XG4gIH1cblxuICBjcmVhdGVDbGFzcyhjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvT2JqZWN0ID0gbW9uZ29TY2hlbWFGcm9tRmllbGRzQW5kQ2xhc3NOYW1lQW5kQ0xQKFxuICAgICAgc2NoZW1hLmZpZWxkcyxcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHNjaGVtYS5jbGFzc0xldmVsUGVybWlzc2lvbnMsXG4gICAgICBzY2hlbWEuaW5kZXhlc1xuICAgICk7XG4gICAgbW9uZ29PYmplY3QuX2lkID0gY2xhc3NOYW1lO1xuICAgIHJldHVybiB0aGlzLnNldEluZGV4ZXNXaXRoU2NoZW1hRm9ybWF0KFxuICAgICAgY2xhc3NOYW1lLFxuICAgICAgc2NoZW1hLmluZGV4ZXMsXG4gICAgICB7fSxcbiAgICAgIHNjaGVtYS5maWVsZHNcbiAgICApXG4gICAgICAudGhlbigoKSA9PiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKCkpXG4gICAgICAudGhlbihzY2hlbWFDb2xsZWN0aW9uID0+IHNjaGVtYUNvbGxlY3Rpb24uaW5zZXJ0U2NoZW1hKG1vbmdvT2JqZWN0KSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGFkZEZpZWxkSWZOb3RFeGlzdHMoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgZmllbGROYW1lOiBzdHJpbmcsXG4gICAgdHlwZTogYW55XG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKClcbiAgICAgIC50aGVuKHNjaGVtYUNvbGxlY3Rpb24gPT5cbiAgICAgICAgc2NoZW1hQ29sbGVjdGlvbi5hZGRGaWVsZElmTm90RXhpc3RzKGNsYXNzTmFtZSwgZmllbGROYW1lLCB0eXBlKVxuICAgICAgKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5jcmVhdGVJbmRleGVzSWZOZWVkZWQoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHR5cGUpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gRHJvcHMgYSBjb2xsZWN0aW9uLiBSZXNvbHZlcyB3aXRoIHRydWUgaWYgaXQgd2FzIGEgUGFyc2UgU2NoZW1hIChlZy4gX1VzZXIsIEN1c3RvbSwgZXRjLilcbiAgLy8gYW5kIHJlc29sdmVzIHdpdGggZmFsc2UgaWYgaXQgd2Fzbid0IChlZy4gYSBqb2luIHRhYmxlKS4gUmVqZWN0cyBpZiBkZWxldGlvbiB3YXMgaW1wb3NzaWJsZS5cbiAgZGVsZXRlQ2xhc3MoY2xhc3NOYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gKFxuICAgICAgdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLmRyb3AoKSlcbiAgICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgICAvLyAnbnMgbm90IGZvdW5kJyBtZWFucyBjb2xsZWN0aW9uIHdhcyBhbHJlYWR5IGdvbmUuIElnbm9yZSBkZWxldGlvbiBhdHRlbXB0LlxuICAgICAgICAgIGlmIChlcnJvci5tZXNzYWdlID09ICducyBub3QgZm91bmQnKSB7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9KVxuICAgICAgICAvLyBXZSd2ZSBkcm9wcGVkIHRoZSBjb2xsZWN0aW9uLCBub3cgcmVtb3ZlIHRoZSBfU0NIRU1BIGRvY3VtZW50XG4gICAgICAgIC50aGVuKCgpID0+IHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKSlcbiAgICAgICAgLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PlxuICAgICAgICAgIHNjaGVtYUNvbGxlY3Rpb24uZmluZEFuZERlbGV0ZVNjaGVtYShjbGFzc05hbWUpXG4gICAgICAgIClcbiAgICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpXG4gICAgKTtcbiAgfVxuXG4gIGRlbGV0ZUFsbENsYXNzZXMoZmFzdDogYm9vbGVhbikge1xuICAgIHJldHVybiBzdG9yYWdlQWRhcHRlckFsbENvbGxlY3Rpb25zKHRoaXMpLnRoZW4oY29sbGVjdGlvbnMgPT5cbiAgICAgIFByb21pc2UuYWxsKFxuICAgICAgICBjb2xsZWN0aW9ucy5tYXAoY29sbGVjdGlvbiA9PlxuICAgICAgICAgIGZhc3QgPyBjb2xsZWN0aW9uLmRlbGV0ZU1hbnkoe30pIDogY29sbGVjdGlvbi5kcm9wKClcbiAgICAgICAgKVxuICAgICAgKVxuICAgICk7XG4gIH1cblxuICAvLyBSZW1vdmUgdGhlIGNvbHVtbiBhbmQgYWxsIHRoZSBkYXRhLiBGb3IgUmVsYXRpb25zLCB0aGUgX0pvaW4gY29sbGVjdGlvbiBpcyBoYW5kbGVkXG4gIC8vIHNwZWNpYWxseSwgdGhpcyBmdW5jdGlvbiBkb2VzIG5vdCBkZWxldGUgX0pvaW4gY29sdW1ucy4gSXQgc2hvdWxkLCBob3dldmVyLCBpbmRpY2F0ZVxuICAvLyB0aGF0IHRoZSByZWxhdGlvbiBmaWVsZHMgZG9lcyBub3QgZXhpc3QgYW55bW9yZS4gSW4gbW9uZ28sIHRoaXMgbWVhbnMgcmVtb3ZpbmcgaXQgZnJvbVxuICAvLyB0aGUgX1NDSEVNQSBjb2xsZWN0aW9uLiAgVGhlcmUgc2hvdWxkIGJlIG5vIGFjdHVhbCBkYXRhIGluIHRoZSBjb2xsZWN0aW9uIHVuZGVyIHRoZSBzYW1lIG5hbWVcbiAgLy8gYXMgdGhlIHJlbGF0aW9uIGNvbHVtbiwgc28gaXQncyBmaW5lIHRvIGF0dGVtcHQgdG8gZGVsZXRlIGl0LiBJZiB0aGUgZmllbGRzIGxpc3RlZCB0byBiZVxuICAvLyBkZWxldGVkIGRvIG5vdCBleGlzdCwgdGhpcyBmdW5jdGlvbiBzaG91bGQgcmV0dXJuIHN1Y2Nlc3NmdWxseSBhbnl3YXlzLiBDaGVja2luZyBmb3JcbiAgLy8gYXR0ZW1wdHMgdG8gZGVsZXRlIG5vbi1leGlzdGVudCBmaWVsZHMgaXMgdGhlIHJlc3BvbnNpYmlsaXR5IG9mIFBhcnNlIFNlcnZlci5cblxuICAvLyBQb2ludGVyIGZpZWxkIG5hbWVzIGFyZSBwYXNzZWQgZm9yIGxlZ2FjeSByZWFzb25zOiB0aGUgb3JpZ2luYWwgbW9uZ29cbiAgLy8gZm9ybWF0IHN0b3JlZCBwb2ludGVyIGZpZWxkIG5hbWVzIGRpZmZlcmVudGx5IGluIHRoZSBkYXRhYmFzZSwgYW5kIHRoZXJlZm9yZVxuICAvLyBuZWVkZWQgdG8ga25vdyB0aGUgdHlwZSBvZiB0aGUgZmllbGQgYmVmb3JlIGl0IGNvdWxkIGRlbGV0ZSBpdC4gRnV0dXJlIGRhdGFiYXNlXG4gIC8vIGFkYXB0ZXJzIHNob3VsZCBpZ25vcmUgdGhlIHBvaW50ZXJGaWVsZE5hbWVzIGFyZ3VtZW50LiBBbGwgdGhlIGZpZWxkIG5hbWVzIGFyZSBpblxuICAvLyBmaWVsZE5hbWVzLCB0aGV5IHNob3cgdXAgYWRkaXRpb25hbGx5IGluIHRoZSBwb2ludGVyRmllbGROYW1lcyBkYXRhYmFzZSBmb3IgdXNlXG4gIC8vIGJ5IHRoZSBtb25nbyBhZGFwdGVyLCB3aGljaCBkZWFscyB3aXRoIHRoZSBsZWdhY3kgbW9uZ28gZm9ybWF0LlxuXG4gIC8vIFRoaXMgZnVuY3Rpb24gaXMgbm90IG9ibGlnYXRlZCB0byBkZWxldGUgZmllbGRzIGF0b21pY2FsbHkuIEl0IGlzIGdpdmVuIHRoZSBmaWVsZFxuICAvLyBuYW1lcyBpbiBhIGxpc3Qgc28gdGhhdCBkYXRhYmFzZXMgdGhhdCBhcmUgY2FwYWJsZSBvZiBkZWxldGluZyBmaWVsZHMgYXRvbWljYWxseVxuICAvLyBtYXkgZG8gc28uXG5cbiAgLy8gUmV0dXJucyBhIFByb21pc2UuXG4gIGRlbGV0ZUZpZWxkcyhjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBmaWVsZE5hbWVzOiBzdHJpbmdbXSkge1xuICAgIGNvbnN0IG1vbmdvRm9ybWF0TmFtZXMgPSBmaWVsZE5hbWVzLm1hcChmaWVsZE5hbWUgPT4ge1xuICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgcmV0dXJuIGBfcF8ke2ZpZWxkTmFtZX1gO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIGZpZWxkTmFtZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBjb25zdCBjb2xsZWN0aW9uVXBkYXRlID0geyAkdW5zZXQ6IHt9IH07XG4gICAgbW9uZ29Gb3JtYXROYW1lcy5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgY29sbGVjdGlvblVwZGF0ZVsnJHVuc2V0J11bbmFtZV0gPSBudWxsO1xuICAgIH0pO1xuXG4gICAgY29uc3Qgc2NoZW1hVXBkYXRlID0geyAkdW5zZXQ6IHt9IH07XG4gICAgZmllbGROYW1lcy5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgc2NoZW1hVXBkYXRlWyckdW5zZXQnXVtuYW1lXSA9IG51bGw7XG4gICAgICBzY2hlbWFVcGRhdGVbJyR1bnNldCddW2BfbWV0YWRhdGEuZmllbGRzX29wdGlvbnMuJHtuYW1lfWBdID0gbnVsbDtcbiAgICB9KTtcblxuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLnVwZGF0ZU1hbnkoe30sIGNvbGxlY3Rpb25VcGRhdGUpKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpKVxuICAgICAgLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PlxuICAgICAgICBzY2hlbWFDb2xsZWN0aW9uLnVwZGF0ZVNjaGVtYShjbGFzc05hbWUsIHNjaGVtYVVwZGF0ZSlcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIFJldHVybiBhIHByb21pc2UgZm9yIGFsbCBzY2hlbWFzIGtub3duIHRvIHRoaXMgYWRhcHRlciwgaW4gUGFyc2UgZm9ybWF0LiBJbiBjYXNlIHRoZVxuICAvLyBzY2hlbWFzIGNhbm5vdCBiZSByZXRyaWV2ZWQsIHJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVqZWN0cy4gUmVxdWlyZW1lbnRzIGZvciB0aGVcbiAgLy8gcmVqZWN0aW9uIHJlYXNvbiBhcmUgVEJELlxuICBnZXRBbGxDbGFzc2VzKCk6IFByb21pc2U8U3RvcmFnZUNsYXNzW10+IHtcbiAgICByZXR1cm4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpXG4gICAgICAudGhlbihzY2hlbWFzQ29sbGVjdGlvbiA9PlxuICAgICAgICBzY2hlbWFzQ29sbGVjdGlvbi5fZmV0Y2hBbGxTY2hlbWFzRnJvbV9TQ0hFTUEoKVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gUmV0dXJuIGEgcHJvbWlzZSBmb3IgdGhlIHNjaGVtYSB3aXRoIHRoZSBnaXZlbiBuYW1lLCBpbiBQYXJzZSBmb3JtYXQuIElmXG4gIC8vIHRoaXMgYWRhcHRlciBkb2Vzbid0IGtub3cgYWJvdXQgdGhlIHNjaGVtYSwgcmV0dXJuIGEgcHJvbWlzZSB0aGF0IHJlamVjdHMgd2l0aFxuICAvLyB1bmRlZmluZWQgYXMgdGhlIHJlYXNvbi5cbiAgZ2V0Q2xhc3MoY2xhc3NOYW1lOiBzdHJpbmcpOiBQcm9taXNlPFN0b3JhZ2VDbGFzcz4ge1xuICAgIHJldHVybiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKClcbiAgICAgIC50aGVuKHNjaGVtYXNDb2xsZWN0aW9uID0+XG4gICAgICAgIHNjaGVtYXNDb2xsZWN0aW9uLl9mZXRjaE9uZVNjaGVtYUZyb21fU0NIRU1BKGNsYXNzTmFtZSlcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIFRPRE86IEFzIHlldCBub3QgcGFydGljdWxhcmx5IHdlbGwgc3BlY2lmaWVkLiBDcmVhdGVzIGFuIG9iamVjdC4gTWF5YmUgc2hvdWxkbid0IGV2ZW4gbmVlZCB0aGUgc2NoZW1hLFxuICAvLyBhbmQgc2hvdWxkIGluZmVyIGZyb20gdGhlIHR5cGUuIE9yIG1heWJlIGRvZXMgbmVlZCB0aGUgc2NoZW1hIGZvciB2YWxpZGF0aW9ucy4gT3IgbWF5YmUgbmVlZHNcbiAgLy8gdGhlIHNjaGVtYSBvbmx5IGZvciB0aGUgbGVnYWN5IG1vbmdvIGZvcm1hdC4gV2UnbGwgZmlndXJlIHRoYXQgb3V0IGxhdGVyLlxuICBjcmVhdGVPYmplY3QoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIG9iamVjdDogYW55LFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb09iamVjdCA9IHBhcnNlT2JqZWN0VG9Nb25nb09iamVjdEZvckNyZWF0ZShcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIG9iamVjdCxcbiAgICAgIHNjaGVtYVxuICAgICk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+XG4gICAgICAgIGNvbGxlY3Rpb24uaW5zZXJ0T25lKG1vbmdvT2JqZWN0LCB0cmFuc2FjdGlvbmFsU2Vzc2lvbilcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSAxMTAwMCkge1xuICAgICAgICAgIC8vIER1cGxpY2F0ZSB2YWx1ZVxuICAgICAgICAgIGNvbnN0IGVyciA9IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICk7XG4gICAgICAgICAgZXJyLnVuZGVybHlpbmdFcnJvciA9IGVycm9yO1xuICAgICAgICAgIGlmIChlcnJvci5tZXNzYWdlKSB7XG4gICAgICAgICAgICBjb25zdCBtYXRjaGVzID0gZXJyb3IubWVzc2FnZS5tYXRjaChcbiAgICAgICAgICAgICAgL2luZGV4OltcXHNhLXpBLVowLTlfXFwtXFwuXStcXCQ/KFthLXpBLVpfLV0rKV8xL1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmIChtYXRjaGVzICYmIEFycmF5LmlzQXJyYXkobWF0Y2hlcykpIHtcbiAgICAgICAgICAgICAgZXJyLnVzZXJJbmZvID0geyBkdXBsaWNhdGVkX2ZpZWxkOiBtYXRjaGVzWzFdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBBZGRlZCB0byBhbGxvdyB0aGUgY3JlYXRpb24gb2YgbXVsdGlwbGUgb2JqZWN0cyBhdCBvbmNlXG4gIGNyZWF0ZU9iamVjdHMoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIG9iamVjdHM6IGFueSxcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbjogP2FueVxuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29PYmplY3RzID0gb2JqZWN0cy5tYXAob2JqZWN0ID0+XG4gICAgICBwYXJzZU9iamVjdFRvTW9uZ29PYmplY3RGb3JDcmVhdGUoY2xhc3NOYW1lLCBvYmplY3QsIHNjaGVtYSlcbiAgICApO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLmluc2VydE1hbnkobW9uZ29PYmplY3RzLCB0cmFuc2FjdGlvbmFsU2Vzc2lvbilcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSAxMTAwMCkge1xuICAgICAgICAgIC8vIER1cGxpY2F0ZSB2YWx1ZVxuICAgICAgICAgIGNvbnN0IGVyciA9IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICk7XG4gICAgICAgICAgZXJyLnVuZGVybHlpbmdFcnJvciA9IGVycm9yO1xuICAgICAgICAgIGlmIChlcnJvci5tZXNzYWdlKSB7XG4gICAgICAgICAgICBjb25zdCBtYXRjaGVzID0gZXJyb3IubWVzc2FnZS5tYXRjaChcbiAgICAgICAgICAgICAgL2luZGV4OltcXHNhLXpBLVowLTlfXFwtXFwuXStcXCQ/KFthLXpBLVpfLV0rKV8xL1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmIChtYXRjaGVzICYmIEFycmF5LmlzQXJyYXkobWF0Y2hlcykpIHtcbiAgICAgICAgICAgICAgZXJyLnVzZXJJbmZvID0geyBkdXBsaWNhdGVkX2ZpZWxkOiBtYXRjaGVzWzFdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBSZW1vdmUgYWxsIG9iamVjdHMgdGhhdCBtYXRjaCB0aGUgZ2l2ZW4gUGFyc2UgUXVlcnkuXG4gIC8vIElmIG5vIG9iamVjdHMgbWF0Y2gsIHJlamVjdCB3aXRoIE9CSkVDVF9OT1RfRk9VTkQuIElmIG9iamVjdHMgYXJlIGZvdW5kIGFuZCBkZWxldGVkLCByZXNvbHZlIHdpdGggdW5kZWZpbmVkLlxuICAvLyBJZiB0aGVyZSBpcyBzb21lIG90aGVyIGVycm9yLCByZWplY3Qgd2l0aCBJTlRFUk5BTF9TRVJWRVJfRVJST1IuXG4gIGRlbGV0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4ge1xuICAgICAgICBjb25zdCBtb25nb1doZXJlID0gdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hKTtcbiAgICAgICAgcmV0dXJuIGNvbGxlY3Rpb24uZGVsZXRlTWFueShtb25nb1doZXJlLCB0cmFuc2FjdGlvbmFsU2Vzc2lvbik7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpXG4gICAgICAudGhlbihcbiAgICAgICAgKHsgcmVzdWx0IH0pID0+IHtcbiAgICAgICAgICBpZiAocmVzdWx0Lm4gPT09IDApIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCxcbiAgICAgICAgICAgICAgJ09iamVjdCBub3QgZm91bmQuJ1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9LFxuICAgICAgICAoKSA9PiB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLFxuICAgICAgICAgICAgJ0RhdGFiYXNlIGFkYXB0ZXIgZXJyb3InXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgKTtcbiAgfVxuXG4gIC8vIEFwcGx5IHRoZSB1cGRhdGUgdG8gYWxsIG9iamVjdHMgdGhhdCBtYXRjaCB0aGUgZ2l2ZW4gUGFyc2UgUXVlcnkuXG4gIHVwZGF0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHVwZGF0ZTogYW55LFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1VwZGF0ZSA9IHRyYW5zZm9ybVVwZGF0ZShjbGFzc05hbWUsIHVwZGF0ZSwgc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1doZXJlID0gdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hKTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT5cbiAgICAgICAgY29sbGVjdGlvbi51cGRhdGVNYW55KG1vbmdvV2hlcmUsIG1vbmdvVXBkYXRlLCB0cmFuc2FjdGlvbmFsU2Vzc2lvbilcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIEF0b21pY2FsbHkgZmluZHMgYW5kIHVwZGF0ZXMgYW4gb2JqZWN0IGJhc2VkIG9uIHF1ZXJ5LlxuICAvLyBSZXR1cm4gdmFsdWUgbm90IGN1cnJlbnRseSB3ZWxsIHNwZWNpZmllZC5cbiAgZmluZE9uZUFuZFVwZGF0ZShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICB1cGRhdGU6IGFueSxcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbjogP2FueVxuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29VcGRhdGUgPSB0cmFuc2Zvcm1VcGRhdGUoY2xhc3NOYW1lLCB1cGRhdGUsIHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29XaGVyZSA9IHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+XG4gICAgICAgIGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5maW5kT25lQW5kVXBkYXRlKG1vbmdvV2hlcmUsIG1vbmdvVXBkYXRlLCB7XG4gICAgICAgICAgcmV0dXJuT3JpZ2luYWw6IGZhbHNlLFxuICAgICAgICAgIHNlc3Npb246IHRyYW5zYWN0aW9uYWxTZXNzaW9uIHx8IHVuZGVmaW5lZCxcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC50aGVuKHJlc3VsdCA9PiBtb25nb09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lLCByZXN1bHQudmFsdWUsIHNjaGVtYSkpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gMTEwMDApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsXG4gICAgICAgICAgICAnQSBkdXBsaWNhdGUgdmFsdWUgZm9yIGEgZmllbGQgd2l0aCB1bmlxdWUgdmFsdWVzIHdhcyBwcm92aWRlZCdcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIHVwZGF0ZU9iamVjdHNCeUJ1bGsoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIG9wZXJhdGlvbnM6IGFueSxcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbjogP2FueVxuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgYnVsa3MgPSBvcGVyYXRpb25zLm1hcCgoe3VwZGF0ZU9uZSwgaW5zZXJ0T25lfSkgPT4ge1xuICAgICAgcmV0dXJuIHVwZGF0ZU9uZSA/IHtcbiAgICAgICAgdXBkYXRlT25lOiB7XG4gICAgICAgICAgZmlsdGVyOiB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHVwZGF0ZU9uZS5maWx0ZXIsIHNjaGVtYSksXG4gICAgICAgICAgdXBkYXRlOiB0cmFuc2Zvcm1VcGRhdGUoY2xhc3NOYW1lLCB1cGRhdGVPbmUudXBkYXRlLCBzY2hlbWEpLFxuICAgICAgICAgIHVwc2VydDogZmFsc2VcbiAgICAgICAgfVxuICAgICAgfSA6IHtcbiAgICAgICAgaW5zZXJ0T25lOiB7XG4gICAgICAgICAgZG9jdW1lbnQ6IHBhcnNlT2JqZWN0VG9Nb25nb09iamVjdEZvckNyZWF0ZShjbGFzc05hbWUsIGluc2VydE9uZS5kb2N1bWVudCwgc2NoZW1hKVxuICAgICAgICB9XG4gICAgICB9O1xuICAgIH0pO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uYnVsa1dyaXRlKGJ1bGtzLCB7XG4gICAgICAgICAgc2Vzc2lvbjogdHJhbnNhY3Rpb25hbFNlc3Npb24gfHwgdW5kZWZpbmVkXG4gICAgICAgIH0pXG4gICAgICApXG4gICAgICAudGhlbihyZXN1bHQgPT4gbW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0KGNsYXNzTmFtZSwgcmVzdWx0LnZhbHVlLCBzY2hlbWEpKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IDExMDAwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICAgJ0EgZHVwbGljYXRlIHZhbHVlIGZvciBhIGZpZWxkIHdpdGggdW5pcXVlIHZhbHVlcyB3YXMgcHJvdmlkZWQnXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBIb3BlZnVsbHkgd2UgY2FuIGdldCByaWQgb2YgdGhpcy4gSXQncyBvbmx5IHVzZWQgZm9yIGNvbmZpZyBhbmQgaG9va3MuXG4gIHVwc2VydE9uZU9iamVjdChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICB1cGRhdGU6IGFueSxcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbjogP2FueVxuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29VcGRhdGUgPSB0cmFuc2Zvcm1VcGRhdGUoY2xhc3NOYW1lLCB1cGRhdGUsIHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29XaGVyZSA9IHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+XG4gICAgICAgIGNvbGxlY3Rpb24udXBzZXJ0T25lKG1vbmdvV2hlcmUsIG1vbmdvVXBkYXRlLCB0cmFuc2FjdGlvbmFsU2Vzc2lvbilcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIEV4ZWN1dGVzIGEgZmluZC4gQWNjZXB0czogY2xhc3NOYW1lLCBxdWVyeSBpbiBQYXJzZSBmb3JtYXQsIGFuZCB7IHNraXAsIGxpbWl0LCBzb3J0IH0uXG4gIGZpbmQoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAge1xuICAgICAgc2tpcCxcbiAgICAgIGxpbWl0LFxuICAgICAgc29ydCxcbiAgICAgIGtleXMsXG4gICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgIGhpbnQsXG4gICAgICBjYXNlSW5zZW5zaXRpdmUsXG4gICAgICBleHBsYWluLFxuICAgIH06IFF1ZXJ5T3B0aW9uc1xuICApOiBQcm9taXNlPGFueT4ge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1doZXJlID0gdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1NvcnQgPSBfLm1hcEtleXMoc29ydCwgKHZhbHVlLCBmaWVsZE5hbWUpID0+XG4gICAgICB0cmFuc2Zvcm1LZXkoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHNjaGVtYSlcbiAgICApO1xuICAgIGNvbnN0IG1vbmdvS2V5cyA9IF8ucmVkdWNlKFxuICAgICAga2V5cyxcbiAgICAgIChtZW1vLCBrZXkpID0+IHtcbiAgICAgICAgaWYgKGtleSA9PT0gJ0FDTCcpIHtcbiAgICAgICAgICBtZW1vWydfcnBlcm0nXSA9IDE7XG4gICAgICAgICAgbWVtb1snX3dwZXJtJ10gPSAxO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIG1lbW9bdHJhbnNmb3JtS2V5KGNsYXNzTmFtZSwga2V5LCBzY2hlbWEpXSA9IDE7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG1lbW87XG4gICAgICB9LFxuICAgICAge31cbiAgICApO1xuXG4gICAgcmVhZFByZWZlcmVuY2UgPSB0aGlzLl9wYXJzZVJlYWRQcmVmZXJlbmNlKHJlYWRQcmVmZXJlbmNlKTtcbiAgICByZXR1cm4gdGhpcy5jcmVhdGVUZXh0SW5kZXhlc0lmTmVlZGVkKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSlcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLmZpbmQobW9uZ29XaGVyZSwge1xuICAgICAgICAgIHNraXAsXG4gICAgICAgICAgbGltaXQsXG4gICAgICAgICAgc29ydDogbW9uZ29Tb3J0LFxuICAgICAgICAgIGtleXM6IG1vbmdvS2V5cyxcbiAgICAgICAgICBtYXhUaW1lTVM6IHRoaXMuX21heFRpbWVNUyxcbiAgICAgICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgICAgICBoaW50LFxuICAgICAgICAgIGNhc2VJbnNlbnNpdGl2ZSxcbiAgICAgICAgICBleHBsYWluLFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLnRoZW4ob2JqZWN0cyA9PiB7XG4gICAgICAgIGlmIChleHBsYWluKSB7XG4gICAgICAgICAgcmV0dXJuIG9iamVjdHM7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG9iamVjdHMubWFwKG9iamVjdCA9PlxuICAgICAgICAgIG1vbmdvT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKVxuICAgICAgICApO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGVuc3VyZUluZGV4KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBmaWVsZE5hbWVzOiBzdHJpbmdbXSxcbiAgICBpbmRleE5hbWU6ID9zdHJpbmcsXG4gICAgY2FzZUluc2Vuc2l0aXZlOiBib29sZWFuID0gZmFsc2UsXG4gICAgaW5kZXhUeXBlOiBhbnkgPSAxXG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IGluZGV4Q3JlYXRpb25SZXF1ZXN0ID0ge307XG4gICAgY29uc3QgbW9uZ29GaWVsZE5hbWVzID0gZmllbGROYW1lcy5tYXAoZmllbGROYW1lID0+XG4gICAgICB0cmFuc2Zvcm1LZXkoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHNjaGVtYSlcbiAgICApO1xuICAgIG1vbmdvRmllbGROYW1lcy5mb3JFYWNoKGZpZWxkTmFtZSA9PiB7XG4gICAgICBpbmRleENyZWF0aW9uUmVxdWVzdFtmaWVsZE5hbWVdID0gaW5kZXhUeXBlO1xuICAgIH0pO1xuXG4gICAgY29uc3QgZGVmYXVsdE9wdGlvbnM6IE9iamVjdCA9IHsgYmFja2dyb3VuZDogdHJ1ZSwgc3BhcnNlOiB0cnVlIH07XG4gICAgY29uc3QgaW5kZXhOYW1lT3B0aW9uczogT2JqZWN0ID0gaW5kZXhOYW1lID8geyBuYW1lOiBpbmRleE5hbWUgfSA6IHt9O1xuICAgIGNvbnN0IGNhc2VJbnNlbnNpdGl2ZU9wdGlvbnM6IE9iamVjdCA9IGNhc2VJbnNlbnNpdGl2ZVxuICAgICAgPyB7IGNvbGxhdGlvbjogTW9uZ29Db2xsZWN0aW9uLmNhc2VJbnNlbnNpdGl2ZUNvbGxhdGlvbigpIH1cbiAgICAgIDoge307XG4gICAgY29uc3QgaW5kZXhPcHRpb25zOiBPYmplY3QgPSB7XG4gICAgICAuLi5kZWZhdWx0T3B0aW9ucyxcbiAgICAgIC4uLmNhc2VJbnNlbnNpdGl2ZU9wdGlvbnMsXG4gICAgICAuLi5pbmRleE5hbWVPcHRpb25zLFxuICAgIH07XG5cbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKFxuICAgICAgICBjb2xsZWN0aW9uID0+XG4gICAgICAgICAgbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT5cbiAgICAgICAgICAgIGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5jcmVhdGVJbmRleChcbiAgICAgICAgICAgICAgaW5kZXhDcmVhdGlvblJlcXVlc3QsXG4gICAgICAgICAgICAgIGluZGV4T3B0aW9ucyxcbiAgICAgICAgICAgICAgZXJyb3IgPT4gKGVycm9yID8gcmVqZWN0KGVycm9yKSA6IHJlc29sdmUoKSlcbiAgICAgICAgICAgIClcbiAgICAgICAgICApXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBDcmVhdGUgYSB1bmlxdWUgaW5kZXguIFVuaXF1ZSBpbmRleGVzIG9uIG51bGxhYmxlIGZpZWxkcyBhcmUgbm90IGFsbG93ZWQuIFNpbmNlIHdlIGRvbid0XG4gIC8vIGN1cnJlbnRseSBrbm93IHdoaWNoIGZpZWxkcyBhcmUgbnVsbGFibGUgYW5kIHdoaWNoIGFyZW4ndCwgd2UgaWdub3JlIHRoYXQgY3JpdGVyaWEuXG4gIC8vIEFzIHN1Y2gsIHdlIHNob3VsZG4ndCBleHBvc2UgdGhpcyBmdW5jdGlvbiB0byB1c2VycyBvZiBwYXJzZSB1bnRpbCB3ZSBoYXZlIGFuIG91dC1vZi1iYW5kXG4gIC8vIFdheSBvZiBkZXRlcm1pbmluZyBpZiBhIGZpZWxkIGlzIG51bGxhYmxlLiBVbmRlZmluZWQgZG9lc24ndCBjb3VudCBhZ2FpbnN0IHVuaXF1ZW5lc3MsXG4gIC8vIHdoaWNoIGlzIHdoeSB3ZSB1c2Ugc3BhcnNlIGluZGV4ZXMuXG4gIGVuc3VyZVVuaXF1ZW5lc3MoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIGZpZWxkTmFtZXM6IHN0cmluZ1tdXG4gICkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBpbmRleENyZWF0aW9uUmVxdWVzdCA9IHt9O1xuICAgIGNvbnN0IG1vbmdvRmllbGROYW1lcyA9IGZpZWxkTmFtZXMubWFwKGZpZWxkTmFtZSA9PlxuICAgICAgdHJhbnNmb3JtS2V5KGNsYXNzTmFtZSwgZmllbGROYW1lLCBzY2hlbWEpXG4gICAgKTtcbiAgICBtb25nb0ZpZWxkTmFtZXMuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgaW5kZXhDcmVhdGlvblJlcXVlc3RbZmllbGROYW1lXSA9IDE7XG4gICAgfSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+XG4gICAgICAgIGNvbGxlY3Rpb24uX2Vuc3VyZVNwYXJzZVVuaXF1ZUluZGV4SW5CYWNrZ3JvdW5kKGluZGV4Q3JlYXRpb25SZXF1ZXN0KVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IDExMDAwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICAgJ1RyaWVkIHRvIGVuc3VyZSBmaWVsZCB1bmlxdWVuZXNzIGZvciBhIGNsYXNzIHRoYXQgYWxyZWFkeSBoYXMgZHVwbGljYXRlcy4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBVc2VkIGluIHRlc3RzXG4gIF9yYXdGaW5kKGNsYXNzTmFtZTogc3RyaW5nLCBxdWVyeTogUXVlcnlUeXBlKSB7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+XG4gICAgICAgIGNvbGxlY3Rpb24uZmluZChxdWVyeSwge1xuICAgICAgICAgIG1heFRpbWVNUzogdGhpcy5fbWF4VGltZU1TLFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gRXhlY3V0ZXMgYSBjb3VudC5cbiAgY291bnQoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgcmVhZFByZWZlcmVuY2U6ID9zdHJpbmcsXG4gICAgaGludDogP21peGVkXG4gICkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICByZWFkUHJlZmVyZW5jZSA9IHRoaXMuX3BhcnNlUmVhZFByZWZlcmVuY2UocmVhZFByZWZlcmVuY2UpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLmNvdW50KHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSwgdHJ1ZSksIHtcbiAgICAgICAgICBtYXhUaW1lTVM6IHRoaXMuX21heFRpbWVNUyxcbiAgICAgICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgICAgICBoaW50LFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgZGlzdGluY3QoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgZmllbGROYW1lOiBzdHJpbmdcbiAgKSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IGlzUG9pbnRlckZpZWxkID1cbiAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1BvaW50ZXInO1xuICAgIGNvbnN0IHRyYW5zZm9ybUZpZWxkID0gdHJhbnNmb3JtS2V5KGNsYXNzTmFtZSwgZmllbGROYW1lLCBzY2hlbWEpO1xuXG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+XG4gICAgICAgIGNvbGxlY3Rpb24uZGlzdGluY3QoXG4gICAgICAgICAgdHJhbnNmb3JtRmllbGQsXG4gICAgICAgICAgdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hKVxuICAgICAgICApXG4gICAgICApXG4gICAgICAudGhlbihvYmplY3RzID0+IHtcbiAgICAgICAgb2JqZWN0cyA9IG9iamVjdHMuZmlsdGVyKG9iaiA9PiBvYmogIT0gbnVsbCk7XG4gICAgICAgIHJldHVybiBvYmplY3RzLm1hcChvYmplY3QgPT4ge1xuICAgICAgICAgIGlmIChpc1BvaW50ZXJGaWVsZCkge1xuICAgICAgICAgICAgcmV0dXJuIHRyYW5zZm9ybVBvaW50ZXJTdHJpbmcoc2NoZW1hLCBmaWVsZE5hbWUsIG9iamVjdCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBtb25nb09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lLCBvYmplY3QsIHNjaGVtYSk7XG4gICAgICAgIH0pO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIGFnZ3JlZ2F0ZShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IGFueSxcbiAgICBwaXBlbGluZTogYW55LFxuICAgIHJlYWRQcmVmZXJlbmNlOiA/c3RyaW5nLFxuICAgIGhpbnQ6ID9taXhlZCxcbiAgICBleHBsYWluPzogYm9vbGVhblxuICApIHtcbiAgICBsZXQgaXNQb2ludGVyRmllbGQgPSBmYWxzZTtcbiAgICBwaXBlbGluZSA9IHBpcGVsaW5lLm1hcChzdGFnZSA9PiB7XG4gICAgICBpZiAoc3RhZ2UuJGdyb3VwKSB7XG4gICAgICAgIHN0YWdlLiRncm91cCA9IHRoaXMuX3BhcnNlQWdncmVnYXRlR3JvdXBBcmdzKHNjaGVtYSwgc3RhZ2UuJGdyb3VwKTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHN0YWdlLiRncm91cC5faWQgJiZcbiAgICAgICAgICB0eXBlb2Ygc3RhZ2UuJGdyb3VwLl9pZCA9PT0gJ3N0cmluZycgJiZcbiAgICAgICAgICBzdGFnZS4kZ3JvdXAuX2lkLmluZGV4T2YoJyRfcF8nKSA+PSAwXG4gICAgICAgICkge1xuICAgICAgICAgIGlzUG9pbnRlckZpZWxkID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHN0YWdlLiRtYXRjaCkge1xuICAgICAgICBzdGFnZS4kbWF0Y2ggPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUFyZ3Moc2NoZW1hLCBzdGFnZS4kbWF0Y2gpO1xuICAgICAgfVxuICAgICAgaWYgKHN0YWdlLiRwcm9qZWN0KSB7XG4gICAgICAgIHN0YWdlLiRwcm9qZWN0ID0gdGhpcy5fcGFyc2VBZ2dyZWdhdGVQcm9qZWN0QXJncyhcbiAgICAgICAgICBzY2hlbWEsXG4gICAgICAgICAgc3RhZ2UuJHByb2plY3RcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChzdGFnZS4kZ2VvTmVhcikge1xuICAgICAgICBzdGFnZS4kZ2VvTmVhci5xdWVyeSA9IHRoaXMuX3BhcnNlQWdncmVnYXRlQXJncyhzY2hlbWEsIHN0YWdlLiRnZW9OZWFyLnF1ZXJ5KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBzdGFnZTtcbiAgICB9KTtcbiAgICByZWFkUHJlZmVyZW5jZSA9IHRoaXMuX3BhcnNlUmVhZFByZWZlcmVuY2UocmVhZFByZWZlcmVuY2UpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLmFnZ3JlZ2F0ZShwaXBlbGluZSwge1xuICAgICAgICAgIHJlYWRQcmVmZXJlbmNlLFxuICAgICAgICAgIG1heFRpbWVNUzogdGhpcy5fbWF4VGltZU1TLFxuICAgICAgICAgIGhpbnQsXG4gICAgICAgICAgZXhwbGFpbixcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICByZXN1bHRzLmZvckVhY2gocmVzdWx0ID0+IHtcbiAgICAgICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlc3VsdCwgJ19pZCcpKSB7XG4gICAgICAgICAgICBpZiAoaXNQb2ludGVyRmllbGQgJiYgcmVzdWx0Ll9pZCkge1xuICAgICAgICAgICAgICByZXN1bHQuX2lkID0gcmVzdWx0Ll9pZC5zcGxpdCgnJCcpWzFdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICByZXN1bHQuX2lkID09IG51bGwgfHxcbiAgICAgICAgICAgICAgcmVzdWx0Ll9pZCA9PSB1bmRlZmluZWQgfHxcbiAgICAgICAgICAgICAgKFsnb2JqZWN0JywgJ3N0cmluZyddLmluY2x1ZGVzKHR5cGVvZiByZXN1bHQuX2lkKSAmJlxuICAgICAgICAgICAgICAgIF8uaXNFbXB0eShyZXN1bHQuX2lkKSlcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICByZXN1bHQuX2lkID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJlc3VsdC5vYmplY3RJZCA9IHJlc3VsdC5faWQ7XG4gICAgICAgICAgICBkZWxldGUgcmVzdWx0Ll9pZDtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gcmVzdWx0cztcbiAgICAgIH0pXG4gICAgICAudGhlbihvYmplY3RzID0+XG4gICAgICAgIG9iamVjdHMubWFwKG9iamVjdCA9PlxuICAgICAgICAgIG1vbmdvT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKVxuICAgICAgICApXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBUaGlzIGZ1bmN0aW9uIHdpbGwgcmVjdXJzaXZlbHkgdHJhdmVyc2UgdGhlIHBpcGVsaW5lIGFuZCBjb252ZXJ0IGFueSBQb2ludGVyIG9yIERhdGUgY29sdW1ucy5cbiAgLy8gSWYgd2UgZGV0ZWN0IGEgcG9pbnRlciBjb2x1bW4gd2Ugd2lsbCByZW5hbWUgdGhlIGNvbHVtbiBiZWluZyBxdWVyaWVkIGZvciB0byBtYXRjaCB0aGUgY29sdW1uXG4gIC8vIGluIHRoZSBkYXRhYmFzZS4gV2UgYWxzbyBtb2RpZnkgdGhlIHZhbHVlIHRvIHdoYXQgd2UgZXhwZWN0IHRoZSB2YWx1ZSB0byBiZSBpbiB0aGUgZGF0YWJhc2VcbiAgLy8gYXMgd2VsbC5cbiAgLy8gRm9yIGRhdGVzLCB0aGUgZHJpdmVyIGV4cGVjdHMgYSBEYXRlIG9iamVjdCwgYnV0IHdlIGhhdmUgYSBzdHJpbmcgY29taW5nIGluLiBTbyB3ZSdsbCBjb252ZXJ0XG4gIC8vIHRoZSBzdHJpbmcgdG8gYSBEYXRlIHNvIHRoZSBkcml2ZXIgY2FuIHBlcmZvcm0gdGhlIG5lY2Vzc2FyeSBjb21wYXJpc29uLlxuICAvL1xuICAvLyBUaGUgZ29hbCBvZiB0aGlzIG1ldGhvZCBpcyB0byBsb29rIGZvciB0aGUgXCJsZWF2ZXNcIiBvZiB0aGUgcGlwZWxpbmUgYW5kIGRldGVybWluZSBpZiBpdCBuZWVkc1xuICAvLyB0byBiZSBjb252ZXJ0ZWQuIFRoZSBwaXBlbGluZSBjYW4gaGF2ZSBhIGZldyBkaWZmZXJlbnQgZm9ybXMuIEZvciBtb3JlIGRldGFpbHMsIHNlZTpcbiAgLy8gICAgIGh0dHBzOi8vZG9jcy5tb25nb2RiLmNvbS9tYW51YWwvcmVmZXJlbmNlL29wZXJhdG9yL2FnZ3JlZ2F0aW9uL1xuICAvL1xuICAvLyBJZiB0aGUgcGlwZWxpbmUgaXMgYW4gYXJyYXksIGl0IG1lYW5zIHdlIGFyZSBwcm9iYWJseSBwYXJzaW5nIGFuICckYW5kJyBvciAnJG9yJyBvcGVyYXRvci4gSW5cbiAgLy8gdGhhdCBjYXNlIHdlIG5lZWQgdG8gbG9vcCB0aHJvdWdoIGFsbCBvZiBpdCdzIGNoaWxkcmVuIHRvIGZpbmQgdGhlIGNvbHVtbnMgYmVpbmcgb3BlcmF0ZWQgb24uXG4gIC8vIElmIHRoZSBwaXBlbGluZSBpcyBhbiBvYmplY3QsIHRoZW4gd2UnbGwgbG9vcCB0aHJvdWdoIHRoZSBrZXlzIGNoZWNraW5nIHRvIHNlZSBpZiB0aGUga2V5IG5hbWVcbiAgLy8gbWF0Y2hlcyBvbmUgb2YgdGhlIHNjaGVtYSBjb2x1bW5zLiBJZiBpdCBkb2VzIG1hdGNoIGEgY29sdW1uIGFuZCB0aGUgY29sdW1uIGlzIGEgUG9pbnRlciBvclxuICAvLyBhIERhdGUsIHRoZW4gd2UnbGwgY29udmVydCB0aGUgdmFsdWUgYXMgZGVzY3JpYmVkIGFib3ZlLlxuICAvL1xuICAvLyBBcyBtdWNoIGFzIEkgaGF0ZSByZWN1cnNpb24uLi50aGlzIHNlZW1lZCBsaWtlIGEgZ29vZCBmaXQgZm9yIGl0LiBXZSdyZSBlc3NlbnRpYWxseSB0cmF2ZXJzaW5nXG4gIC8vIGRvd24gYSB0cmVlIHRvIGZpbmQgYSBcImxlYWYgbm9kZVwiIGFuZCBjaGVja2luZyB0byBzZWUgaWYgaXQgbmVlZHMgdG8gYmUgY29udmVydGVkLlxuICBfcGFyc2VBZ2dyZWdhdGVBcmdzKHNjaGVtYTogYW55LCBwaXBlbGluZTogYW55KTogYW55IHtcbiAgICBpZiAocGlwZWxpbmUgPT09IG51bGwpIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheShwaXBlbGluZSkpIHtcbiAgICAgIHJldHVybiBwaXBlbGluZS5tYXAodmFsdWUgPT4gdGhpcy5fcGFyc2VBZ2dyZWdhdGVBcmdzKHNjaGVtYSwgdmFsdWUpKTtcbiAgICB9IGVsc2UgaWYgKHBpcGVsaW5lIGluc3RhbmNlb2YgRGF0ZSkge1xuICAgICAgcmV0dXJuIHBpcGVsaW5lO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHBpcGVsaW5lID09PSAnb2JqZWN0Jykge1xuICAgICAgY29uc3QgcmV0dXJuVmFsdWUgPSB7fTtcbiAgICAgIGZvciAoY29uc3QgZmllbGQgaW4gcGlwZWxpbmUpIHtcbiAgICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGRdICYmIHNjaGVtYS5maWVsZHNbZmllbGRdLnR5cGUgPT09ICdQb2ludGVyJykge1xuICAgICAgICAgIGlmICh0eXBlb2YgcGlwZWxpbmVbZmllbGRdID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgLy8gUGFzcyBvYmplY3RzIGRvd24gdG8gTW9uZ29EQi4uLnRoaXMgaXMgbW9yZSB0aGFuIGxpa2VseSBhbiAkZXhpc3RzIG9wZXJhdG9yLlxuICAgICAgICAgICAgcmV0dXJuVmFsdWVbYF9wXyR7ZmllbGR9YF0gPSBwaXBlbGluZVtmaWVsZF07XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVyblZhbHVlW1xuICAgICAgICAgICAgICBgX3BfJHtmaWVsZH1gXG4gICAgICAgICAgICBdID0gYCR7c2NoZW1hLmZpZWxkc1tmaWVsZF0udGFyZ2V0Q2xhc3N9JCR7cGlwZWxpbmVbZmllbGRdfWA7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGRdICYmXG4gICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSA9PT0gJ0RhdGUnXG4gICAgICAgICkge1xuICAgICAgICAgIHJldHVyblZhbHVlW2ZpZWxkXSA9IHRoaXMuX2NvbnZlcnRUb0RhdGUocGlwZWxpbmVbZmllbGRdKTtcbiAgICAgICAgfSBlbHNlIGlmIChwaXBlbGluZVtmaWVsZF0gJiYgcGlwZWxpbmVbZmllbGRdLl9fdHlwZSA9PT0gXCJEYXRlXCIpIHtcbiAgICAgICAgICByZXR1cm5WYWx1ZVtmaWVsZF0gPSB0aGlzLl9jb252ZXJ0VG9EYXRlKHBpcGVsaW5lW2ZpZWxkXS5pc28pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJldHVyblZhbHVlW2ZpZWxkXSA9IHRoaXMuX3BhcnNlQWdncmVnYXRlQXJncyhcbiAgICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICAgIHBpcGVsaW5lW2ZpZWxkXVxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZmllbGQgPT09ICdvYmplY3RJZCcpIHtcbiAgICAgICAgICByZXR1cm5WYWx1ZVsnX2lkJ10gPSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgICAgZGVsZXRlIHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gJ2NyZWF0ZWRBdCcpIHtcbiAgICAgICAgICByZXR1cm5WYWx1ZVsnX2NyZWF0ZWRfYXQnXSA9IHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgICBkZWxldGUgcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICB9IGVsc2UgaWYgKGZpZWxkID09PSAndXBkYXRlZEF0Jykge1xuICAgICAgICAgIHJldHVyblZhbHVlWydfdXBkYXRlZF9hdCddID0gcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICAgIGRlbGV0ZSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiByZXR1cm5WYWx1ZTtcbiAgICB9XG4gICAgcmV0dXJuIHBpcGVsaW5lO1xuICB9XG5cbiAgLy8gVGhpcyBmdW5jdGlvbiBpcyBzbGlnaHRseSBkaWZmZXJlbnQgdGhhbiB0aGUgb25lIGFib3ZlLiBSYXRoZXIgdGhhbiB0cnlpbmcgdG8gY29tYmluZSB0aGVzZVxuICAvLyB0d28gZnVuY3Rpb25zIGFuZCBtYWtpbmcgdGhlIGNvZGUgZXZlbiBoYXJkZXIgdG8gdW5kZXJzdGFuZCwgSSBkZWNpZGVkIHRvIHNwbGl0IGl0IHVwLiBUaGVcbiAgLy8gZGlmZmVyZW5jZSB3aXRoIHRoaXMgZnVuY3Rpb24gaXMgd2UgYXJlIG5vdCB0cmFuc2Zvcm1pbmcgdGhlIHZhbHVlcywgb25seSB0aGUga2V5cyBvZiB0aGVcbiAgLy8gcGlwZWxpbmUuXG4gIF9wYXJzZUFnZ3JlZ2F0ZVByb2plY3RBcmdzKHNjaGVtYTogYW55LCBwaXBlbGluZTogYW55KTogYW55IHtcbiAgICBjb25zdCByZXR1cm5WYWx1ZSA9IHt9O1xuICAgIGZvciAoY29uc3QgZmllbGQgaW4gcGlwZWxpbmUpIHtcbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgcmV0dXJuVmFsdWVbYF9wXyR7ZmllbGR9YF0gPSBwaXBlbGluZVtmaWVsZF07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm5WYWx1ZVtmaWVsZF0gPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUFyZ3Moc2NoZW1hLCBwaXBlbGluZVtmaWVsZF0pO1xuICAgICAgfVxuXG4gICAgICBpZiAoZmllbGQgPT09ICdvYmplY3RJZCcpIHtcbiAgICAgICAgcmV0dXJuVmFsdWVbJ19pZCddID0gcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICBkZWxldGUgcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gJ2NyZWF0ZWRBdCcpIHtcbiAgICAgICAgcmV0dXJuVmFsdWVbJ19jcmVhdGVkX2F0J10gPSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgIGRlbGV0ZSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkID09PSAndXBkYXRlZEF0Jykge1xuICAgICAgICByZXR1cm5WYWx1ZVsnX3VwZGF0ZWRfYXQnXSA9IHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgZGVsZXRlIHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJldHVyblZhbHVlO1xuICB9XG5cbiAgLy8gVGhpcyBmdW5jdGlvbiBpcyBzbGlnaHRseSBkaWZmZXJlbnQgdGhhbiB0aGUgdHdvIGFib3ZlLiBNb25nb0RCICRncm91cCBhZ2dyZWdhdGUgbG9va3MgbGlrZTpcbiAgLy8gICAgIHsgJGdyb3VwOiB7IF9pZDogPGV4cHJlc3Npb24+LCA8ZmllbGQxPjogeyA8YWNjdW11bGF0b3IxPiA6IDxleHByZXNzaW9uMT4gfSwgLi4uIH0gfVxuICAvLyBUaGUgPGV4cHJlc3Npb24+IGNvdWxkIGJlIGEgY29sdW1uIG5hbWUsIHByZWZpeGVkIHdpdGggdGhlICckJyBjaGFyYWN0ZXIuIFdlJ2xsIGxvb2sgZm9yXG4gIC8vIHRoZXNlIDxleHByZXNzaW9uPiBhbmQgY2hlY2sgdG8gc2VlIGlmIGl0IGlzIGEgJ1BvaW50ZXInIG9yIGlmIGl0J3Mgb25lIG9mIGNyZWF0ZWRBdCxcbiAgLy8gdXBkYXRlZEF0IG9yIG9iamVjdElkIGFuZCBjaGFuZ2UgaXQgYWNjb3JkaW5nbHkuXG4gIF9wYXJzZUFnZ3JlZ2F0ZUdyb3VwQXJncyhzY2hlbWE6IGFueSwgcGlwZWxpbmU6IGFueSk6IGFueSB7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkocGlwZWxpbmUpKSB7XG4gICAgICByZXR1cm4gcGlwZWxpbmUubWFwKHZhbHVlID0+XG4gICAgICAgIHRoaXMuX3BhcnNlQWdncmVnYXRlR3JvdXBBcmdzKHNjaGVtYSwgdmFsdWUpXG4gICAgICApO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHBpcGVsaW5lID09PSAnb2JqZWN0Jykge1xuICAgICAgY29uc3QgcmV0dXJuVmFsdWUgPSB7fTtcbiAgICAgIGZvciAoY29uc3QgZmllbGQgaW4gcGlwZWxpbmUpIHtcbiAgICAgICAgcmV0dXJuVmFsdWVbZmllbGRdID0gdGhpcy5fcGFyc2VBZ2dyZWdhdGVHcm91cEFyZ3MoXG4gICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgIHBpcGVsaW5lW2ZpZWxkXVxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJldHVyblZhbHVlO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHBpcGVsaW5lID09PSAnc3RyaW5nJykge1xuICAgICAgY29uc3QgZmllbGQgPSBwaXBlbGluZS5zdWJzdHJpbmcoMSk7XG4gICAgICBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZF0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSA9PT0gJ1BvaW50ZXInKSB7XG4gICAgICAgIHJldHVybiBgJF9wXyR7ZmllbGR9YDtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGQgPT0gJ2NyZWF0ZWRBdCcpIHtcbiAgICAgICAgcmV0dXJuICckX2NyZWF0ZWRfYXQnO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PSAndXBkYXRlZEF0Jykge1xuICAgICAgICByZXR1cm4gJyRfdXBkYXRlZF9hdCc7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBwaXBlbGluZTtcbiAgfVxuXG4gIC8vIFRoaXMgZnVuY3Rpb24gd2lsbCBhdHRlbXB0IHRvIGNvbnZlcnQgdGhlIHByb3ZpZGVkIHZhbHVlIHRvIGEgRGF0ZSBvYmplY3QuIFNpbmNlIHRoaXMgaXMgcGFydFxuICAvLyBvZiBhbiBhZ2dyZWdhdGlvbiBwaXBlbGluZSwgdGhlIHZhbHVlIGNhbiBlaXRoZXIgYmUgYSBzdHJpbmcgb3IgaXQgY2FuIGJlIGFub3RoZXIgb2JqZWN0IHdpdGhcbiAgLy8gYW4gb3BlcmF0b3IgaW4gaXQgKGxpa2UgJGd0LCAkbHQsIGV0YykuIEJlY2F1c2Ugb2YgdGhpcyBJIGZlbHQgaXQgd2FzIGVhc2llciB0byBtYWtlIHRoaXMgYVxuICAvLyByZWN1cnNpdmUgbWV0aG9kIHRvIHRyYXZlcnNlIGRvd24gdG8gdGhlIFwibGVhZiBub2RlXCIgd2hpY2ggaXMgZ29pbmcgdG8gYmUgdGhlIHN0cmluZy5cbiAgX2NvbnZlcnRUb0RhdGUodmFsdWU6IGFueSk6IGFueSB7XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHJldHVybiBuZXcgRGF0ZSh2YWx1ZSk7XG4gICAgfVxuXG4gICAgY29uc3QgcmV0dXJuVmFsdWUgPSB7fTtcbiAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHZhbHVlKSB7XG4gICAgICByZXR1cm5WYWx1ZVtmaWVsZF0gPSB0aGlzLl9jb252ZXJ0VG9EYXRlKHZhbHVlW2ZpZWxkXSk7XG4gICAgfVxuICAgIHJldHVybiByZXR1cm5WYWx1ZTtcbiAgfVxuXG4gIF9wYXJzZVJlYWRQcmVmZXJlbmNlKHJlYWRQcmVmZXJlbmNlOiA/c3RyaW5nKTogP3N0cmluZyB7XG4gICAgaWYgKHJlYWRQcmVmZXJlbmNlKSB7XG4gICAgICByZWFkUHJlZmVyZW5jZSA9IHJlYWRQcmVmZXJlbmNlLnRvVXBwZXJDYXNlKCk7XG4gICAgfVxuICAgIHN3aXRjaCAocmVhZFByZWZlcmVuY2UpIHtcbiAgICAgIGNhc2UgJ1BSSU1BUlknOlxuICAgICAgICByZWFkUHJlZmVyZW5jZSA9IFJlYWRQcmVmZXJlbmNlLlBSSU1BUlk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnUFJJTUFSWV9QUkVGRVJSRUQnOlxuICAgICAgICByZWFkUHJlZmVyZW5jZSA9IFJlYWRQcmVmZXJlbmNlLlBSSU1BUllfUFJFRkVSUkVEO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ1NFQ09OREFSWSc6XG4gICAgICAgIHJlYWRQcmVmZXJlbmNlID0gUmVhZFByZWZlcmVuY2UuU0VDT05EQVJZO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ1NFQ09OREFSWV9QUkVGRVJSRUQnOlxuICAgICAgICByZWFkUHJlZmVyZW5jZSA9IFJlYWRQcmVmZXJlbmNlLlNFQ09OREFSWV9QUkVGRVJSRUQ7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnTkVBUkVTVCc6XG4gICAgICAgIHJlYWRQcmVmZXJlbmNlID0gUmVhZFByZWZlcmVuY2UuTkVBUkVTVDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIHVuZGVmaW5lZDpcbiAgICAgIGNhc2UgbnVsbDpcbiAgICAgIGNhc2UgJyc6XG4gICAgICAgIGJyZWFrO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICAgJ05vdCBzdXBwb3J0ZWQgcmVhZCBwcmVmZXJlbmNlLidcbiAgICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgcGVyZm9ybUluaXRpYWxpemF0aW9uKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIGNyZWF0ZUluZGV4KGNsYXNzTmFtZTogc3RyaW5nLCBpbmRleDogYW55KSB7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5jcmVhdGVJbmRleChpbmRleCkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBjcmVhdGVJbmRleGVzKGNsYXNzTmFtZTogc3RyaW5nLCBpbmRleGVzOiBhbnkpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLmNyZWF0ZUluZGV4ZXMoaW5kZXhlcykpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBjcmVhdGVJbmRleGVzSWZOZWVkZWQoY2xhc3NOYW1lOiBzdHJpbmcsIGZpZWxkTmFtZTogc3RyaW5nLCB0eXBlOiBhbnkpIHtcbiAgICBpZiAodHlwZSAmJiB0eXBlLnR5cGUgPT09ICdQb2x5Z29uJykge1xuICAgICAgY29uc3QgaW5kZXggPSB7XG4gICAgICAgIFtmaWVsZE5hbWVdOiAnMmRzcGhlcmUnLFxuICAgICAgfTtcbiAgICAgIHJldHVybiB0aGlzLmNyZWF0ZUluZGV4KGNsYXNzTmFtZSwgaW5kZXgpO1xuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICBjcmVhdGVUZXh0SW5kZXhlc0lmTmVlZGVkKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgc2NoZW1hOiBhbnlcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgZm9yIChjb25zdCBmaWVsZE5hbWUgaW4gcXVlcnkpIHtcbiAgICAgIGlmICghcXVlcnlbZmllbGROYW1lXSB8fCAhcXVlcnlbZmllbGROYW1lXS4kdGV4dCkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGV4aXN0aW5nSW5kZXhlcyA9IHNjaGVtYS5pbmRleGVzO1xuICAgICAgZm9yIChjb25zdCBrZXkgaW4gZXhpc3RpbmdJbmRleGVzKSB7XG4gICAgICAgIGNvbnN0IGluZGV4ID0gZXhpc3RpbmdJbmRleGVzW2tleV07XG4gICAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoaW5kZXgsIGZpZWxkTmFtZSkpIHtcbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGNvbnN0IGluZGV4TmFtZSA9IGAke2ZpZWxkTmFtZX1fdGV4dGA7XG4gICAgICBjb25zdCB0ZXh0SW5kZXggPSB7XG4gICAgICAgIFtpbmRleE5hbWVdOiB7IFtmaWVsZE5hbWVdOiAndGV4dCcgfSxcbiAgICAgIH07XG4gICAgICByZXR1cm4gdGhpcy5zZXRJbmRleGVzV2l0aFNjaGVtYUZvcm1hdChcbiAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICB0ZXh0SW5kZXgsXG4gICAgICAgIGV4aXN0aW5nSW5kZXhlcyxcbiAgICAgICAgc2NoZW1hLmZpZWxkc1xuICAgICAgKS5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSA4NSkge1xuICAgICAgICAgIC8vIEluZGV4IGV4aXN0IHdpdGggZGlmZmVyZW50IG9wdGlvbnNcbiAgICAgICAgICByZXR1cm4gdGhpcy5zZXRJbmRleGVzRnJvbU1vbmdvKGNsYXNzTmFtZSk7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgZ2V0SW5kZXhlcyhjbGFzc05hbWU6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uaW5kZXhlcygpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgZHJvcEluZGV4KGNsYXNzTmFtZTogc3RyaW5nLCBpbmRleDogYW55KSB7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5kcm9wSW5kZXgoaW5kZXgpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgZHJvcEFsbEluZGV4ZXMoY2xhc3NOYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLmRyb3BJbmRleGVzKCkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICB1cGRhdGVTY2hlbWFXaXRoSW5kZXhlcygpOiBQcm9taXNlPGFueT4ge1xuICAgIHJldHVybiB0aGlzLmdldEFsbENsYXNzZXMoKVxuICAgICAgLnRoZW4oY2xhc3NlcyA9PiB7XG4gICAgICAgIGNvbnN0IHByb21pc2VzID0gY2xhc3Nlcy5tYXAoc2NoZW1hID0+IHtcbiAgICAgICAgICByZXR1cm4gdGhpcy5zZXRJbmRleGVzRnJvbU1vbmdvKHNjaGVtYS5jbGFzc05hbWUpO1xuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UuYWxsKHByb21pc2VzKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBjcmVhdGVUcmFuc2FjdGlvbmFsU2Vzc2lvbigpOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IHRyYW5zYWN0aW9uYWxTZWN0aW9uID0gdGhpcy5jbGllbnQuc3RhcnRTZXNzaW9uKCk7XG4gICAgdHJhbnNhY3Rpb25hbFNlY3Rpb24uc3RhcnRUcmFuc2FjdGlvbigpO1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUodHJhbnNhY3Rpb25hbFNlY3Rpb24pO1xuICB9XG5cbiAgY29tbWl0VHJhbnNhY3Rpb25hbFNlc3Npb24odHJhbnNhY3Rpb25hbFNlY3Rpb246IGFueSk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiB0cmFuc2FjdGlvbmFsU2VjdGlvbi5jb21taXRUcmFuc2FjdGlvbigpLnRoZW4oKCkgPT4ge1xuICAgICAgdHJhbnNhY3Rpb25hbFNlY3Rpb24uZW5kU2Vzc2lvbigpO1xuICAgIH0pO1xuICB9XG5cbiAgYWJvcnRUcmFuc2FjdGlvbmFsU2Vzc2lvbih0cmFuc2FjdGlvbmFsU2VjdGlvbjogYW55KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIHRyYW5zYWN0aW9uYWxTZWN0aW9uLmFib3J0VHJhbnNhY3Rpb24oKS50aGVuKCgpID0+IHtcbiAgICAgIHRyYW5zYWN0aW9uYWxTZWN0aW9uLmVuZFNlc3Npb24oKTtcbiAgICB9KTtcbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBNb25nb1N0b3JhZ2VBZGFwdGVyO1xuIl19