'use strict'

const merge = require('lodash.merge')
const proto = require('./constants/proto')
const serializer = require('../lib/serializer')
const valueEquals = require('../lib/valueEquals')

/**
 * @param {string} type e.g. 'historySite'
 * @param {Function} isValidRecord checks if the update record has enough props to make a create record
 * @param {Function} mapUpdateToCreate converts props from the update record to the create record
 * @returns {Function}
 */
const CreateFromUpdate = (type, isValidRecord, mapUpdateToCreate) => {
  if (!type || !isValidRecord || !mapUpdateToCreate) {
    throw new Error('type, isValidRecord, mapUpdateToCreate are required args')
  }
  return (record) => {
    if (!record[type]) { throw new Error(`Record missing ${type}`) }
    if (!isValidRecord(record)) { return null }
    const resolvedTypeProps = mapUpdateToCreate(record[type])
    return Object.assign(
      record,
      { action: proto.actions.CREATE, [type]: resolvedTypeProps }
    )
  }
}

const createSitePropsFromUpdateSite = (site) => {
  const defaultProps = {
    title: '',
    customTitle: site.location,
    lastAccessedTime: Date.now(),
    creationTime: Date.now()
  }
  return Object.assign({}, defaultProps, site)
}

const createFromUpdateBookmark = CreateFromUpdate(
  'bookmark',
  (record) => {
    return (record.bookmark.site && (
      record.bookmark.site.location ||
      (record.bookmark.site.customTitle && record.bookmark.folderId && record.bookmark.folderId > 0)
    ))
  },
  (bookmark) => {
    if (bookmark.folderId && bookmark.folderId > 0) {
      return Object.assign({isFolder: true}, bookmark)
    } else {
      const defaultProps = {
        isFolder: false
      }
      const site = createSitePropsFromUpdateSite(bookmark.site)
      return Object.assign({}, defaultProps, bookmark, {site})
    }
  }
)

const createFromUpdateHistorySite = CreateFromUpdate(
  'historySite',
  (record) => { return !!record.historySite.location },
  createSitePropsFromUpdateSite
)

const createFromUpdateSiteSetting = CreateFromUpdate(
  'siteSetting',
  (record) => { return !!record.siteSetting.hostPattern },
  (siteSetting) => { return siteSetting }
)

module.exports.createFromUpdate = (record) => {
  if (!record || record.action !== proto.actions.UPDATE) {
    throw new Error('Missing UPDATE syncRecord.')
  }
  switch (record.objectData) {
    case 'bookmark':
      return createFromUpdateBookmark(record)
    case 'historySite':
      return createFromUpdateHistorySite(record)
    case 'siteSetting':
      return createFromUpdateSiteSetting(record)
    default:
      console.log(`Warning: invalid objectData ${record.objectData}`)
      return null
  }
}

const pickFields = (object, fields) => {
  return fields.reduce((a, x) => {
    if (object.hasOwnProperty(x)) { a[x] = object[x] }
    return a
  }, {})
}

/**
 * Given a SyncRecord and a browser's matching existing object, resolve
 * objectData to only have the applicable fields.
 * @param {Object} record SyncRecord JS object
 * @param {Object=} existingObject Browser object as syncRecord JS object
 * @returns {Object|null} Resolved syncRecord to apply to browser data
 */
const resolveRecordWithObject = (record, existingObject) => {
  const commonFields = ['hostPattern']
  const type = record.objectData
  const recordFields = new Set(Object.keys(record[type]))
  const existingFields = new Set(Object.keys(existingObject[type]))

  let resolveField = null
  if (record.action === proto.actions.UPDATE) {
    resolveField = (field) => {
      return !commonFields.includes(field) &&
      (!existingFields.has(field) || !valueEquals(existingObject[type][field], record[type][field]))
    }
  } else if (record.action === proto.actions.DELETE) {
    resolveField = (field) => {
      return !commonFields.includes(field) && existingFields.has(field)
    }
  } else {
    throw new Error('Invalid record action')
  }
  const resolvedFields = [...recordFields].filter(resolveField)
  const resolvedData = pickFields(record[type], resolvedFields)
  if (Object.keys(resolvedData).length === 0) {
    return null
  }
  let resolved = Object.assign({}, record, {[type]: resolvedData})
  for (let field of commonFields) {
    if (!recordFields.has(field)) { continue }
    resolved[type][field] = record[type][field]
  }
  return resolved
}

/**
 * Given a new SyncRecord and a browser's matching existing object if available,
 * resolve the write to perform on the browser's data.
 * @param {Object} record syncRecord as a JS object
 * @param {Object=} existingObject Browser object as syncRecord JS object
 * @returns {Object} Resolved syncRecord to apply to browser data
 */
module.exports.resolve = (record, existingObject) => {
  if (!record) { throw new Error('Missing syncRecord JS object.') }
  const nullIgnore = () => {
    console.log(`Ignoring ${record.action} of object ${record.objectId}.`)
    return null
  }
  switch (record.action) {
    case proto.actions.CREATE:
      return existingObject
        ? nullIgnore()
        : record
    case proto.actions.UPDATE:
      const resolvedUpdate = existingObject
        ? resolveRecordWithObject(record, existingObject)
        : this.createFromUpdate(record)
      return resolvedUpdate || nullIgnore()
    case proto.actions.DELETE:
      const resolvedDelete = existingObject
        ? resolveRecordWithObject(record, existingObject)
        : null
      return resolvedDelete || nullIgnore()
    default:
      throw new Error(`Invalid record action: ${record.action}`)
  }
}

/**
 * Given two SyncRecords, merge objectData of record2 into record1.
 * @param {Object} record1
 * @param {Object} record2
 * @returns {Object} merged record
 */
const mergeRecord = (record1, record2) => {
  if (record1.objectData !== record2.objectData) {
    throw new Error('Records with same objectId have mismatched objectData!')
  }
  return merge(record1, record2)
}

/**
 * Within an array of [record, object], merge items whose records have the
 * same objectId.
 * @param {Array} recordsAndObjects Same format as input to resolveRecords().
 * @returns {Array}
 */
const mergeRecords = (recordsAndObjects) => {
  let idsAndIndices = {}
  let outputList = []
  for (let n = 0; n < recordsAndObjects.length; n++) {
    const recordAndObject = recordsAndObjects[n]
    const record = recordAndObject[0]
    const object = recordAndObject[1]
    const id = JSON.stringify(record.objectId)
    const previousIndex = idsAndIndices[id]
    if (previousIndex >= 0) {
      const previousRecord = recordsAndObjects[previousIndex][0]
      const mergedRecord = mergeRecord(previousRecord, record)
      outputList[previousIndex] = [mergedRecord, object]
    } else {
      idsAndIndices[id] = outputList.length
      outputList.push(recordAndObject)
    }
  }
  return outputList
}

/**
 * Given a list of new SyncRecords and matching browser objects, resolve
 * writes to perform on the browser's data.
 * @param {Array} recordsAndExistingObjects
 * @returns {Array.<Object>} Resolved syncRecords to apply to browser data.
 */
module.exports.resolveRecords = (recordsAndExistingObjects) => {
  let resolvedRecords = []
  const merged = mergeRecords(recordsAndExistingObjects)
  merged.forEach(([record, existingObject]) => {
    const resolved = this.resolve(record, existingObject)
    if (resolved) { resolvedRecords.push(resolved) }
  })
  return resolvedRecords
}

/**
 * Given a SyncRecord protobuf object, convert to a basic JS object.
 * @param {Serializer.api.SyncRecord}
 * @returns {Object}
 */
module.exports.syncRecordAsJS = (record) => {
  /* We should be able to call toObject({defaults: true}) but it doesn't work.
   * I think it's because objectData is a oneof.
   * .toObject() options:
   * http://dcode.io/protobuf.js/global.html#ConversionOptions
   */
  let object = record.toObject()
  object.action = record.action
  const type = serializer.getSyncRecordObjectData(record)
  object.objectData = type
  const data = record[type].toObject({defaults: true, enums: Number, longs: Number})
  if (data.fields && data.fields.length > 0) {
    object[type] = pickFields(data, data.fields)
  } else {
    object[type] = data
  }
  return object
}
