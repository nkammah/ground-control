import {
  GraphQLBoolean,
  GraphQLList,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLID,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLScalarType
} from 'graphql'

import {
  connectionArgs,
  connectionDefinitions,
  connectionFromArray,
  fromGlobalId,
  globalIdField,
  mutationWithClientMutationId,
  nodeDefinitions,
} from 'graphql-relay'

import moment from 'moment-timezone'
import Promise from 'bluebird'
import Maestro from '../maestro'
import url from 'url'
import TZLookup from 'tz-lookup'
import BSDClient from '../bsd-instance'
import knex from './knex'
import humps from 'humps'
import log from '../log'
import MG from '../mail'

const Mailgun = new MG(process.env.MAILGUN_KEY, process.env.MAILGUN_DOMAIN)
const EVERYONE_GROUP = 'everyone'

class GraphQLError extends Error {
  constructor(errorObject) {
    let message = JSON.stringify(errorObject)
    super(message)

    this.name = 'GraphQLError',
    this.message = message,
    Error.captureStackTrace(this, this.constructor.name)
  }
}

function activeCallAssignments(query) {
  return query
    .where('end_dt', '>', moment().add(1, 'days').toDate())
    .orWhere('end_dt', null)
}

function inactiveCallAssignments(query) {
  return query
    .where('end_dt', '<', moment().add(1, 'days').toDate())
}

function interpretDateAsUTC(date) {
  return moment.tz(moment(date).format('YYYY-MM-DD HH:mm:ss'), 'UTC').toDate()
}

function authRequired (session) {
  if (!session.user) {
    throw new GraphQLError({
      status: 401,
      message: 'You must login to access that resource.'
    })
  }
}

function adminRequired(session) {
  authRequired(session)
  if (!session.user || !session.user.is_admin) {
    throw new GraphQLError({
      status: 403,
      message: 'You are not authorized to access that resource.'
    })
  }
}

// We should move these into model-helpers or something
function modelFromBSDResponse(BSDObject, type) {
  let modelKeys = {
    'bsd_surveys': ['signup_form_id', 'signup_form_slug', 'modified_dt', 'create_dt'],
    'bsd_groups': ['cons_group_id', 'name', 'description', 'modified_dt', 'create_dt'],
    'bsd_survey_fields': ['signup_form_field_id', 'modified_dt', 'create_dt', 'signup_form_id', 'format', 'label', 'display_order', 'is_shown', 'is_required', 'description']
  }
  let keys = modelKeys[type]
  let model = {}
  keys.forEach((key) => model[key] = BSDObject[key])
  return model;
}

function eventFieldFromAPIField(field) {

  let mapFields = {
    'id': 'eventId',
    'hostId': 'creatorConsId',
    'startDate': 'startDt',
    'createDate': 'createDt',
    'localTimezone': 'startTz',
    'venueState': 'venueStateCd'
  }

  let newFieldName = field;

  Object.keys(mapFields).forEach((key) => {
    if (field === key)
      newFieldName = mapFields[key]
    }
  )

  return humps.decamelize(newFieldName);
}

function eventFromAPIFields(fields) {
  let event = {}
  Object.keys(fields).forEach((fieldName) => {
    let newFieldName = eventFieldFromAPIField(fieldName)
    event[newFieldName] = fields[fieldName]

    if (newFieldName === 'start_dt')
      event[newFieldName] = event[newFieldName].toISOString()
  })

  let idFields = ['event_id', 'creator_cons_id', 'event_type_id'];
  idFields.forEach((field) => {
    if (event[field]) {
      event[field] = fromGlobalId(event[field]).id
    }
  })

  return event
}

async function getPrimaryEmail(person, transaction) {
  let query = knex('bsd_emails')
    .where({
      is_primary: true,
      cons_id: person.cons_id
    })
    .select('email')
    .first()

  if (transaction)
    query = query.transacting(transaction)

  let emails = await query
  return emails ? emails.email : null
}

async function getPrimaryAddress(person, transaction) {
  let query = knex('bsd_addresses')
    .where({
      is_primary: true,
      cons_id: person.cons_id
    })
    .first()
  if (transaction)
    query = query.transacting(transaction)
  return query
}

async function getPrimaryPhone(person, transaction) {
  let query = knex('bsd_phones')
    .where({
      is_primary: true,
      cons_id: person.cons_id
    })
    .select('phone')
    .first()

  if (transaction)
    query = query.transacting(transaction)

  let phones = await query
  return phones ? phones.phone : null;
}

const SharedListContainer = {
  id: 1,
  _type: 'list_container'
}

async function addType(query) {
  let table = query._single.tablename
  let results = await query
  results._type = table;
  return results
}

let {nodeInterface, nodeField} = nodeDefinitions(
  (globalId) => {
    let {type, id} = fromGlobalId(globalId)
    if (type === 'Call')
      return addType(knex('bsd_calls').where('id', id))
    if (type === 'Person')
      return addType(knex('bsd_people').where('cons_id', id))
    if (type === 'CallAssignment')
      return addType(knex('bsd_call_assignments').where('id', id))
    if (type === 'Survey')
      return addType(knex('gc_bsd_surveys').where('id', id))
    if (type === 'EventType')
      return addType(knex('bsd_event_types').where('event_type_id', id))
    if (type === 'Event')
      return addType(knex('bsd_events').where('event_id', id))
    if (type === 'User')
      return addType(knex('users').where('id', id))
    if (type === 'Address')
      return addType(knex('bsd_addresses').where('cons_addr_id', id))
    if (type === 'ListContainer')
      return SharedListContainer
    return null
  },
  (obj) => {
    if (obj._type === 'users')
      return GraphQLUser
    if (obj._type === 'bsd_call_assignments')
      return GraphQLCallAssignment
    if (obj._type === 'bsd_calls')
      return GraphQLCall
    if (obj._type === 'gc_bsd_surveys')
      return GraphQLSurvey
    if (obj._type === 'list_container')
      return GraphQLListContainer
    if (obj._type === 'bsd_event_types')
      return GraphQLEventType
    if (obj._type === 'bsd_events')
      return GraphQLEvent
    if (obj._type === 'bsd_addresses')
      return GraphQLAddress
    if (obj._type == 'users')
      return GraphQLUser
    return null
  }
)

const GraphQLDate = new GraphQLScalarType({
  name: 'Date',
  serialize (value) {
    if (value === null)
      return null
    if (!(value instanceof Date)) {
      throw new Error('Field error: value is not an instance of Date')
    }

    return value.toJSON()
  },
  parseValue (value) {
    const date = new Date(value)

    return date
  },
  parseLiteral (ast) {
    if (ast.kind !== Kind.STRING) {
      throw new GraphQLError('Query error: Can only parse strings to dates but got a: ' + ast.kind, [ast])
    }
    let result = new Date(ast.value)
    if (isNaN(result.getTime())) {
      throw new GraphQLError('Query error: Invalid date', [ast])
    }
    if (ast.value !== result.toJSON()) {
      throw new GraphQLError('Query error: Invalid date format, only accepts: YYYY-MM-DDTHH:MM:SS.SSSZ', [ast])
    }
    return result
  }
})

const GraphQLListContainer = new GraphQLObjectType({
  name: 'ListContainer',
  fields: () => ({
    id: globalIdField('ListContainer'),
    eventTypes: {
      type: new GraphQLList(GraphQLEventType),
      resolve: async (eventType, {rootValue}) => {
        return knex('bsd_event_types')
      }
    },
    events: {
      type: GraphQLEventConnection,
      args: {
        ...connectionArgs,
        filterOptions: {type: GraphQLEventInput },
        sortField: {type: GraphQLString},
        sortDirection: {type: new GraphQLEnumType({
          name: 'GraphQLSortDirection',
          values: {
            ASC: { value: 'asc' },
            DESC: { value: 'desc' }
          }
        })}
      },
      resolve: async (event, {first, filterOptions, sortField, sortDirection}, {rootValue}) => {
        let filters = eventFromAPIFields(filterOptions);
        let convertedSortField = eventFieldFromAPIField(sortField)

        let events = await knex('bsd_events')
          .where('start_dt', '>=', new Date())
          .where(filters)
          .limit(first)
          .orderBy(convertedSortField, sortDirection)
        return connectionFromArray(events, {first})
      }
    },
    callAssignments: {
      type: GraphQLCallAssignmentConnection,
      args: {
        ...connectionArgs,
        active: { type: GraphQLBoolean }
      },
      resolve: async (root, {first, active}, {rootValue}) => {
        let query = knex('bsd_call_assignments').limit(first)
        if (active === true)
          query = activeCallAssignments(query)
        else if (active === false)
          query = inactiveCallAssignments(query)
        let assignments = await query
        return connectionFromArray(assignments, {first})
      }
    },
  }),
  interfaces: [nodeInterface]
})

const GraphQLUser = new GraphQLObjectType({
  name: 'User',
  description: 'User of ground control',
  fields: () => ({
    id: globalIdField('User'),
    email: { type: GraphQLString },
    relatedPerson: {
      type: GraphQLPerson,
      resolve: async (user, _, {rootValue}) => {
        let relatedPerson = await knex('bsd_emails')
          .select('cons_id')
          .where('email', user.email)
          .first()
        return relatedPerson ? rootValue.loaders.bsdPeople.load(relatedPerson.cons_id) : null
      }
    },
    firstName: {
      type: GraphQLString,
      resolve: async (user) => {
        let name = await knex('bsd_emails')
          .select('bsd_people.firstname')
          .innerJoin('bsd_people', 'bsd_emails.cons_id', 'bsd_people.cons_id')
          .where('email', user.email)
          .first()
        if (name)
          return name['firstname']
        return null;
      }
    },
    callAssignments: {
      type: GraphQLCallAssignmentConnection,
      args: {
        ...connectionArgs,
        active: { type: GraphQLBoolean }
      },
      resolve: async (user, {first, active}) => {
        let nullQuery = knex('bsd_call_assignments')
          .where('caller_group', null)
        let callerQuery = knex('bsd_call_assignments')
          .select('bsd_call_assignments.*')
          .innerJoin('user_user_groups', 'bsd_call_assignments.caller_group', 'user_user_groups.user_group_id')
          .where('user_user_groups.user_id', user.id)
        // This is duplicated code from the other callAssignments resolve method
        if (active === true) {
          nullQuery = activeCallAssignments(nullQuery)
          callerQuery = activeCallAssignments(callerQuery)
        }
        else if (active === false) {
          nullQuery = inactiveCallAssignments(nullQuery)
          callerQuery = inactiveCallAssignments(callerQuery)
        }

        let assignments = await knex.union([
          nullQuery, callerQuery
        ])

        return connectionFromArray(assignments, {first})
      }
    },
    callsMade: {
      type: GraphQLInt,
      args: {
        forAssignmentId: { type: GraphQLString },
        completed: { type: GraphQLBoolean }
      },
      resolve: async (user, {forAssignmentId, completed}) => {
        let query = knex('bsd_calls').where('caller_id', user.id)

        if (forAssignmentId) {
          let localId = fromGlobalId(forAssignmentId).id
          query = query.where('call_assignment_id', localId)
        }

        if (typeof completed !== 'undefined')
          query = query.where('completed', completed)

        return knex.count(query, 'id')
      }
    },
    intervieweeForCallAssignment: {
      type: GraphQLPerson,
      args: {
        callAssignmentId: { type: GraphQLString }
      },
      resolve: async (user, {callAssignmentId}, {rootValue}) => {
        let localId = fromGlobalId(callAssignmentId).id

        let assignedCall = await knex('bsd_assigned_calls').where({
          'caller_id': user.id,
          'call_assignment_id': localId
        }).first()

        if (assignedCall) {
          return rootValue.loaders.bsdPeople.load(assignedCall.interviewee_id)
        } else {
          let callAssignment = await rootValue.loaders.bsdCallAssignments.load(localId)
          let allOffsets = [-10, -9, -8, -7, -6, -5, -4]
          let validOffsets = []
          // So that I can program late at night
          if (process.env.NODE_ENV === 'development')
            validOffsets = allOffsets

          allOffsets.forEach((offset) => {
            let time = moment().utcOffset(offset)

            if (time.hours() >= 9 && time.hours() <= 21)
              validOffsets.push(offset)
          })

          if (validOffsets.length === 0)
            return null

          let group = await rootValue.loaders.gcBsdGroups.load(callAssignment.interviewee_group)

          let previousCallsSubquery = knex('bsd_calls')
            .select('interviewee_id')
            .where(function() {
              this.where('call_assignment_id', localId)
                .where('completed', true)
                .where('attempted_at', '>', new Date(new Date() - 14 * 24 * 60 * 60 * 1000))
            })
            .orWhere(function() {
              this.whereIn('reason_not_completed', ['NO_PICKUP', 'CALL_BACK', 'NOT_INTERESTED'])
                .where('attempted_at', '>', new Date(new Date() - 7 * 24 * 60 * 60 * 1000))
            })
            .orWhereIn('reason_not_completed', ['WRONG_NUMBER', 'DISCONNECTED_NUMBER', 'OTHER_LANGUAGE'])
            .orWhere(function() {
              this.where('call_assignment_id', localId)
                .where('reason_not_completed', 'NOT_INTERESTED')
            })

          let query = knex.select('bsd_people.cons_id')

          if (group.cons_group_id) {
            query = query
              .from('bsd_person_bsd_groups as bsd_people')
              .where('bsd_people.cons_group_id', group.cons_group_id)
          } else if (group.query && group.query !== EVERYONE_GROUP) {
            query = query
              .from('bsd_person_gc_bsd_groups as bsd_people')
              .where('gc_bsd_group_id', group.id)
              .orderBy('bsd_people.id')
          } else {
            query = query.from('bsd_people')
          }

          let assignedCallsSubquery = knex('bsd_assigned_calls')
            .select('interviewee_id')

          let userAddress = await knex('bsd_emails')
            .select('bsd_emails.cons_id', 'zip_codes.timezone_offset', 'bsd_addresses.latitude', 'bsd_addresses.longitude')
            .innerJoin('bsd_addresses', 'bsd_emails.cons_id', 'bsd_addresses.cons_id')
            .innerJoin('zip_codes', 'zip_codes.zip', 'bsd_addresses.zip')
            .where('bsd_emails.email', user.email)
            .where('bsd_addresses.is_primary', true)
            .first()

          query = query
            .join('bsd_emails', 'bsd_people.cons_id', 'bsd_emails.cons_id')
            .join('bsd_phones', 'bsd_people.cons_id', 'bsd_phones.cons_id')
            .join('bsd_addresses', 'bsd_people.cons_id', 'bsd_addresses.cons_id')
            .join('zip_codes', 'zip_codes.zip', 'bsd_addresses.zip')
            // Doing these subqueries instead of a left outer join because a left outer join seems to make the whole thing run really slow if I add any sort of sorting at the end of this query.
            .whereNotIn('bsd_people.cons_id', previousCallsSubquery)
            .whereNotIn('bsd_people.cons_id', assignedCallsSubquery)
            .whereNotIn('bsd_addresses.state_cd', ['IA', 'NH', 'NV', 'SC'])
            .whereIn('zip_codes.timezone_offset', validOffsets)
            .where('bsd_addresses.is_primary', true)
            .where('bsd_phones.is_primary', true)
            .where('bsd_emails.is_primary', true)
            .limit(1)
            .first()

          if (userAddress)
            query = query.whereNot('bsd_people.cons_id', userAddress.cons_id)

          // No geo sort for now, still seeing timeouts in production probably from this
          // if (userAddress && validOffsets.indexOf(userAddress.timezone_offset) !== -1 && userAddress.latitude && userAddress.longitude)
          // query = query.orderByRaw(`"bsd_addresses"."geom" <-> st_transform(st_setsrid(st_makepoint(${userAddress.longitude}, ${userAddress.latitude}), 4326), 900913)`)

          log.info(`Running query: ${query}`)

          let person = await query
          let timestamp = new Date()

          if (person) {
            // Do this check again to avoid race conditions
            let assignedCall = await knex('bsd_assigned_calls').where({
              'caller_id': user.id,
              'call_assignment_id': localId
            }).first()

            if (assignedCall)
              return rootValue.loaders.bsdPeople.load(assignedCall.interviewee_id)

            await knex('bsd_assigned_calls')
              .insert({
                caller_id: user.id,
                interviewee_id: person.cons_id,
                call_assignment_id: localId,
                create_dt: timestamp,
                modified_dt: timestamp
            })

            return rootValue.loaders.bsdPeople.load(person.cons_id)
          }

          return null
        }
      }
    }
  }),
  interfaces: [nodeInterface]
})

const GraphQLAddress = new GraphQLObjectType({
  name: 'Address',
  description: 'An address',
  fields: () => ({
    id: globalIdField('Address', (obj) => obj.cons_addr_id),
    personId: {
      type: GraphQLInt,
      resolve: (address) => address.cons_id
    },
    addr1: { type: GraphQLString },
    addr2: { type: GraphQLString },
    addr3: { type: GraphQLString },
    city: { type: GraphQLString },
    state: {
      type: GraphQLString,
      resolve: (address) => address.state_cd
    },
    zip: { type: GraphQLString },
    latitude: { type: GraphQLFloat },
    longitude: { type: GraphQLFloat },
    localUTCOffset: {
      type: GraphQLString,
      resolve: async (address) => {
        let tz = TZLookup(address.latitude, address.longitude)
        return moment().tz(tz).format('Z')
      }
    },
    people: {
      type: new GraphQLList(GraphQLPerson),
      resolve: async (address, _, {rootValue}) => {
        return knex('bsd_people').where('cons_id', address.cons_id)
      }
    }
  }),
  interfaces: [nodeInterface]
})

const GraphQLPerson = new GraphQLObjectType({
  name: 'Person',
  description: 'A person.',
  fields: () => ({
    id: globalIdField('Person', (obj) => obj.cons_id),
    prefix: { type: GraphQLString },
    firstName: {
      type: GraphQLString,
      resolve: (person) => person.firstname
    },
    middleName: {
      type: GraphQLString,
      resolve: (person) => person.middlename
    },
    lastName: {
      type: GraphQLString,
      resolve: (person) => person.lastname
    },
    suffix: { type: GraphQLString },
    gender: { type: GraphQLString },
    birthDate: {
      type: GraphQLDate,
      resolve: (person) => interpretDateAsUTC(person.birth_dt)
    },
    title: { type: GraphQLString },
    employer: { type: GraphQLString },
    occupation: { type: GraphQLString },
    phone: {
      type: GraphQLString,
      resolve: async (person, _, {rootValue}) => {
        return getPrimaryPhone(person)
      }
    },
    email: {
      type: GraphQLString,
      resolve: async (person) => {
        return getPrimaryEmail(person)
      }
    },
    address: {
      type: GraphQLAddress,
      resolve: async (person, _, {rootValue}) => {
        return getPrimaryAddress(person)
      }
    },
    lastCalled: {
      type: GraphQLString,
      resolve: async (person) => {
        let lastCall = await knex('bsd_calls')
          .where('interviewee_id', person.cons_id)
          .orderBy('create_dt', 'desc')
          .first()

        return lastCall ? lastCall.create_dt : null
      }
    },
    nearbyEvents: {
      type: new GraphQLList(GraphQLEvent),
      args: {
        within: { type: GraphQLInt },
        type: { type: GraphQLString }
      },
      resolve: async (person, {within, type}, {rootValue}) => {
        let address = await getPrimaryAddress(person);
        let boundingDistance = within / 69
        let eventTypes = null
        if (type) {
          eventTypes = await knex('bsd_event_types')
            .where('name', 'ilike', `%${type}%`)
            .select('event_type_id')
        }

        let query = knex('bsd_events')
          .whereRaw(`ST_DWithin(bsd_events.geom, st_transform(st_setsrid(st_makepoint(${address.longitude}, ${address.latitude}), 4326), 900913), ${within * 1000})`)
          .where('start_dt', '>', new Date())
          .where('flag_approval', false)
          .whereNot('is_searchable', 0)

        if (eventTypes)
          query = query.whereIn('event_type_id', eventTypes.map((type) => type.event_type_id))

        return query
      }
    }
  }),
  interfaces: [nodeInterface]
})

const GraphQLCall = new GraphQLObjectType({
  name: 'Call',
  description: 'A call between a user and a person',
  fields: () => ({
    id: globalIdField('Call'),
    attemptedAt: { type: GraphQLString },
    leftVoicemail: { type: GraphQLBoolean },
    sentText: { type: GraphQLBoolean },
    completed: { type: GraphQLBoolean },
    reasonNotCompleted: { type: GraphQLString },
    caller: { type: GraphQLUser },
    interviewee: { type: GraphQLPerson },
    callAssignment: { type: GraphQLCallAssignment }
  })
})

const GraphQLEventType = new GraphQLObjectType({
  name: 'EventType',
  description: 'An event type',
  fields: () => ({
    id: globalIdField('EventType', (obj) => obj.event_type_id),
    name: { type: GraphQLString },
    description: { type: GraphQLString }
  })
})

const GraphQLEventAttendee = new GraphQLObjectType({
  name: 'EventAttendee',
  description: 'An event attendee',
  fields: () => ({
    id: globalIdField('EventAttendee', (obj) => obj.event_attendee_id),
  }),
  interfaces: [nodeInterface]
})

let {
  connectionType: GraphQLEventTypeConnection,
} = connectionDefinitions({
  name: 'EventType',
  nodeType: GraphQLEventType
})

const GraphQLEvent = new GraphQLObjectType({
  name: 'Event',
  description: 'An event',
  fields: () => ({
    id: globalIdField('Event', (obj) => obj.event_id),
    eventIdObfuscated: {
      type: GraphQLString,
      resolve: (event) => event.event_id_obfuscated
    },
    host: {
      type: GraphQLPerson,
      resolve: async (event, _, {rootValue}) => rootValue.loaders.bsdPeople.load(event.creator_cons_id)
    },
    eventType: {
      type: GraphQLEventType,
      resolve: (event, _, {rootValue}) => rootValue.loaders.bsdEventTypes.load(event.event_type_id)
    },
    flagApproval: {
      type: GraphQLBoolean,
      resolve: (event) => event.flag_approval
    },
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    venueName: {
      type: GraphQLString,
      resolve: (event) => event.venue_name
    },
    venueZip: {
      type: GraphQLString,
      resolve: (event) => event.venue_zip
    },
    venueCity: {
      type: GraphQLString,
      resolve: (event) => event.venue_city
    },
    venueState: {
      type: GraphQLString,
      resolve: (event) => event.venue_state_cd
    },
    venueAddr1: {
      type: GraphQLString,
      resolve: (event) => event.venue_addr1
    },
    venueAddr2: {
      type: GraphQLString,
      resolve: (event) => event.venue_addr2
    },
    venueCountry: {
      type: GraphQLString,
      resolve: (event) => event.venue_country
    },
    venueDirections: {
      type: GraphQLString,
      resolve: (event) => event.venue_directions
    },
    localTimezone: {
      type: GraphQLString,
      resolve: (event) => {
        let zone = moment.tz.zone(event.start_tz)
        return zone ? zone.name : null;
      }
    },
    localUTCOffset: {
      type: GraphQLString,
      resolve: (event) => {
        let tz = moment().tz(event.start_tz);
        return tz ? tz.format('Z') : '+0000'
      }
    },
    startDate: {
      type: GraphQLDate,
      resolve: (event) => {
        return interpretDateAsUTC(event.start_dt)
      }
    },
    createDate: {
      type: GraphQLDate,
      resolve: (event) => {
        return interpretDateAsUTC(event.create_dt)
      }
    },
    duration: { type: GraphQLInt },
    capacity: { type: GraphQLInt },
    latitude: { type: GraphQLFloat },
    longitude: { type: GraphQLFloat },
    attendeeVolunteerShow: {
      type: GraphQLInt,
      resolve: (event) => event.attendee_volunteer_show
    },
    attendeeVolunteerMessage: {
      type: GraphQLString,
      resolve: (event) => event.attendee_volunteer_message
    },
    isSearchable: {
      type: GraphQLInt,
      resolve: (event) => event.is_searchable
    },
    publicPhone: {
      type: GraphQLBoolean,
      resolve: (event) => event.public_phone
    },
    contactPhone: {
      type: GraphQLString,
      resolve: (event) => event.contact_phone
    },
    hostReceiveRsvpEmails: {
      type: GraphQLBoolean,
      resolve: (event) => event.host_receive_rsvp_emails
    },
    rsvpUseReminderEmail: {
      type: GraphQLBoolean,
      resolve: (event) => event.rsvp_use_reminder_email
    },
    rsvpEmailReminderHours: {
      type: GraphQLInt,
      resolve: (event) => event.rsvp_email_reminder_hours
    },
    link: {
      type: GraphQLString,
      resolve: (event) => {
        return url.resolve('https://' + process.env.BSD_HOST, '/page/event/detail/' + event.event_id_obfuscated)
      }
    },
    attendeesCount: {
      type: GraphQLInt,
      resolve: async(event) => {
        return knex.count(knex('bsd_event_attendees').where('event_id', event.id), 'event_attendee_id')
      }
    },
    nearbyPeople: {
      type: new GraphQLList(GraphQLPerson),
      resolve: async(event, _, {rootValue}) => {
        let addresses =
          await knex('bsd_addresses')
            .join('bsd_people', 'bsd_addresses.cons_id', 'bsd_people.cons_id')
            .join('bsd_emails', 'bsd_people.cons_id', 'bsd_emails.cons_id')
            .join('bsd_phones', 'bsd_people.cons_id', 'bsd_phones.cons_id')
            .where('bsd_emails.is_primary', true)
            .whereNotNull('bsd_phones.phone')
            .whereRaw(`st_dwithin(bsd_addresses.geom, st_transform(st_setsrid(st_makepoint(${event.longitude}, ${event.latitude}), 4326), 900913), 50000)`)
            .orderByRaw(`bsd_addresses.geom <-> st_transform(st_setsrid(st_makepoint(${event.longitude}, ${event.latitude}), 4326), 900913)`)
            .orderBy('bsd_people.create_dt')
            .limit(500)

        return await addresses.map((address) => rootValue.loaders.bsdPeople.load(address.cons_id))
      }
    }
  }),
  interfaces: [nodeInterface]
})

let {
  connectionType: GraphQLEventConnection,
} = connectionDefinitions({
  name: 'Event',
  nodeType: GraphQLEvent
})

const GraphQLCallAssignment = new GraphQLObjectType({
  name: 'CallAssignment',
  description: 'A mass calling assignment',
  fields: () => ({
    id: globalIdField('CallAssignment'),
    name: { type: GraphQLString },
    instructions: { type: GraphQLString },
    endDate: {
      type: GraphQLDate,
      resolve: (assignment) => {
        return moment(assignment.end_dt).toDate()
      }
    },
    survey: {
      type: GraphQLSurvey,
      resolve: (assignment, _, {rootValue}) => rootValue.loaders.gcBsdSurveys.load(assignment.gc_bsd_survey_id)
    },
    renderer: { type: GraphQLString },
    callsMade: {
      type: GraphQLInt,
      resolve: async (callAssignment) => {
        return knex.count(knex('bsd_calls').where('call_assignment_id', callAssignment.id), 'id')
      }
    },
    relatedEvent: {
      type: GraphQLEvent,
      resolve: async (assignment, _, {rootValue}) => {
        let eventId = await knex('gc_bsd_events').where('gc_bsd_events.turn_out_assignment', assignment.id)
          .select('event_id')
          .first()

        return eventId ? rootValue.loaders.bsdEvents.load(eventId.event_id) : null
      }
    },
    query: {
      type: GraphQLString,
      resolve: async (assignment, _, {rootValue}) => {
        let group = await rootValue.loaders.gcBsdGroups.load(assignment.interviewee_group)
        if (group.cons_group_id) {
          return 'BSD Constituent Group: ' + group.cons_group_id
        }
        else
          return group.query
      }
    }
  }),
  interfaces: [nodeInterface]
})

let {
  connectionType: GraphQLCallAssignmentConnection,
} = connectionDefinitions({
  name: 'CallAssignment',
  nodeType: GraphQLCallAssignment
})

const GraphQLSurvey = new GraphQLObjectType({
  name: 'Survey',
  description: 'A survey to be filled out by a person',
  fields: () => ({
    id: globalIdField('Survey'),
    fullURL: {
      type: GraphQLString,
      resolve: async (survey, _, {rootValue}) => {
        let underlyingSurvey = await rootValue.loaders.bsdSurveys.load(survey.signup_form_id)
        let slug = underlyingSurvey.signup_form_slug
        return url.resolve('https://' + process.env.BSD_HOST, '/page/s/' + slug)
      }
    },
  }),
  interfaces: [nodeInterface]
})

const GraphQLEventInput = new GraphQLInputObjectType({
  name: 'EventInput',
  fields: {
    id: { type: GraphQLString },
    eventIdObfuscated: { type: GraphQLString },
    eventTypeId: { type: GraphQLString },
    hostId: { type: GraphQLString },
    flagApproval: { type: GraphQLBoolean },
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    venueName: { type: GraphQLString },
    venueZip: { type: GraphQLString },
    venueCity: { type: GraphQLString },
    venueState: { type: GraphQLString },
    venueAddr1: { type: GraphQLString },
    venueAddr2: { type: GraphQLString },
    venueCountry: { type: GraphQLString },
    venueDirections: { type: GraphQLString },
    localTimezone: { type: GraphQLString },
    createDate: { type: GraphQLDate },
    startDate: { type: GraphQLDate }, // This should be CustomGraphQLDateType, but it's broken until a PR gets merged in to the graphql-custome-datetype repo
    duration: { type: GraphQLInt },
    latitude: { type: GraphQLFloat },
    longitude: { type: GraphQLFloat },
    capacity: { type: GraphQLInt },
    attendeeVolunteerShow: { type: GraphQLInt },
    attendeeVolunteerMessage: { type: GraphQLString },
    isSearchable: { type: GraphQLInt },
    publicPhone: { type: GraphQLBoolean },
    contactPhone: { type: GraphQLString },
    hostReceiveRsvpEmails: { type: GraphQLBoolean },
    rsvpUseReminderEmail: { type: GraphQLBoolean },
    rsvpEmailReminderHours: { type: GraphQLInt },
  }
})

const GraphQLEditEvents = mutationWithClientMutationId({
  name: 'EditEvents',
  inputFields: {
    events: { type: new GraphQLNonNull(new GraphQLList(GraphQLEventInput)) }
  },
  outputFields: {
    listContainer: {
      type: GraphQLListContainer,
      resolve: () => SharedListContainer
    }
  },
  mutateAndGetPayload: async ({events}, {rootValue}) => {
    adminRequired(rootValue)
    let params = events.map((event) => {
      return eventFromAPIFields(event)
    })
    let count = params.length;

    for (let index = 0; index < count; index++) {
      let newEventData = params[index]

      let event = await knex('bsd_events')
        .where('event_id', newEventData.event_id)
        .first()
      event = {
        ...event,
        ...newEventData
      }

      log.debug('Updated event: ', event)

      await BSDClient.updateEvent(event.event_id_obfuscated, event.event_type_id, event.creator_cons_id, event)
      await knex('bsd_events')
        .where('event_id', event.event_id)
        .update({
          ...event,
          modified_dt: new Date()
        })
    }
    return events;
  }
})

const GraphQLDeleteEvents = mutationWithClientMutationId({
  name: 'DeleteEvents',
  inputFields: {
    ids: { type: new GraphQLNonNull(new GraphQLList(GraphQLString)) }
  },
  outputFields: {
    listContainer: {
      type: GraphQLListContainer,
      resolve: () => SharedListContainer
    }
  },
  mutateAndGetPayload: async ({ids}, {rootValue}) => {
    adminRequired(rootValue)
    let localIds = ids.map((id) => fromGlobalId(id).id)
    await BSDClient.deleteEvents(localIds)
    await knex('bsd_events')
      .whereIn('event_id', localIds)
      .del()
    return localIds
  }
})

const GraphQLSubmitCallSurvey = mutationWithClientMutationId({
  name: 'SubmitCallSurvey',
  inputFields: {
    callAssignmentId: { type: new GraphQLNonNull(GraphQLString) },
    intervieweeId: { type: new GraphQLNonNull(GraphQLString) },
    completed: { type: new GraphQLNonNull(GraphQLBoolean) },
    leftVoicemail: { type: GraphQLBoolean },
    sentText: { type: GraphQLBoolean },
    reasonNotCompleted: { type: GraphQLString },
    surveyFieldValues: { type: new GraphQLNonNull(GraphQLString) }
  },
  outputFields: {
    currentUser: {
      type: GraphQLUser,
    }
  },
  mutateAndGetPayload: async ({callAssignmentId, intervieweeId, completed, leftVoicemail, sentText, reasonNotCompleted, surveyFieldValues}, {rootValue}) => {
    authRequired(rootValue)

    let caller = rootValue.user
    let localIntervieweeId = fromGlobalId(intervieweeId).id
    let localCallAssignmentId = fromGlobalId(callAssignmentId).id

    return knex.transaction(async (trx) => {
      // To ensure that the assigned call exists
      let assignedCall = await knex('bsd_assigned_calls')
        .transacting(trx)
        .where('caller_id', caller.id)
        .where('call_assignment_id', localCallAssignmentId)
        .first()

      if (!assignedCall) {
        throw new Error(`No assigned call found when caller ${caller.id} submitted call survey for interviwee ${localIntervieweeId}`)
      }

      let assignedCallInfo = {
        callerId: assignedCall.caller_id,
        intervieweeId: assignedCall.interviewee_id,
        callAssignmentId: assignedCall.call_assignment_id
      }

      let submittedCallInfo = {
        callerId: caller.id,
        intervieweeId: localIntervieweeId,
        callAssignmentId: localCallAssignmentId
      }

      Object.keys(assignedCallInfo).forEach((key) => {
        if (assignedCallInfo[key] !== submittedCallInfo[key]) {
          throw new Error('Assigned call does not match submitted call info.\n assignedCallInfo:' + JSON.stringify(assignedCallInfo) + '\nsubmittedCallInfo:' + JSON.stringify(submittedCallInfo))
        }
      })

      let callAssignment = await knex('bsd_call_assignments')
        .transacting(trx)
        .where('id', localCallAssignmentId)
        .first()

      let survey = await knex('gc_bsd_surveys')
        .transacting(trx)
        .where('id', callAssignment.gc_bsd_survey_id)
        .first()

      let fieldValues = JSON.parse(surveyFieldValues)

      fieldValues['person'] = await knex('bsd_people')
        .transacting(trx)
        .where('cons_id', localIntervieweeId)
        .first()

      let person = fieldValues['person']
      let email = await getPrimaryEmail(person, trx)
      let processorsLength = survey.processors.length

      if (completed && processorsLength > 0) {
        for (let index = 0; index < processorsLength; index++) {
          let processor = survey.processors[index]

          switch (processor) {
            case 'bsd-event-rsvper':
              if (fieldValues['event_id']) {
                let address = await getPrimaryAddress(person, trx)
                let phone = await getPrimaryPhone(person, trx)
                let zip = address.zip
                await BSDClient.noFailApiRequest('addRSVPToEvent', email, zip, phone, fieldValues['event_id'])
              }
              break
            case 'bsd-form-submitter':
              let bsdFormValues = {}

              if (email) {
                fieldValues['Email'] = email
                let fields = Object.keys(fieldValues)

                for (let index = 0; index < fields.length; index++) {
                  let field = fields[index]
                  let fieldId = field

                  // Field is not a numeric id
                  if (!(/^\d+$/.test(field))) {
                    let fieldObj = await knex('bsd_survey_fields')
                      .select('signup_form_field_id')
                      .where('signup_form_id', survey.signup_form_id)
                      .where('label', field)
                      .transacting(trx)
                      .first()

                    if (!fieldObj)
                      fieldObj = await knex('bsd_survey_fields')
                        .where('signup_form_id', survey.signup_form_id)
                        .where('label', 'ilike', `[${field}]%`)
                        .transacting(trx)
                        .first()

                    if (fieldObj) {
                      fieldId = fieldObj.signup_form_field_id
                    } else {
                      fieldId = null
                    }
                  }

                  if (fieldId)
                    bsdFormValues[fieldId] = fieldValues[field]
                }

                await BSDClient.noFailApiRequest('processSignup', survey.signup_form_id, bsdFormValues)
              } else {
                log.error(`Could not find an e-mail address for constituent: ${localIntervieweeId}`)
              }
              break
          }
        }
      }

      let promises = [
        knex('bsd_assigned_calls')
          .transacting(trx)
          .where('id', assignedCall.id)
          .del(),
        knex.insertAndFetch('bsd_calls', {
            completed: completed,
            attempted_at: new Date(),
            left_voicemail: leftVoicemail,
            sent_text: sentText,
            reason_not_completed: reasonNotCompleted,
            caller_id: caller.id,
            interviewee_id: assignedCall.interviewee_id,
            call_assignment_id: assignedCall.call_assignment_id
          }, {transaction: trx})
      ]
      await Promise.all(promises)
      return caller
    })
  }
})

const GraphQLCreateAdminEventEmail = mutationWithClientMutationId({
  name: 'CreateAdminEventEmail',
  inputFields: {
    hostEmail: { type: new GraphQLNonNull(GraphQLString) },
    senderEmail: { type: new GraphQLNonNull(GraphQLString) },
    hostMessage: { type: new GraphQLNonNull(GraphQLString) },
    senderMessage: { type: new GraphQLNonNull(GraphQLString) },
    recipientIds: { type: new GraphQLList(GraphQLString) },
    toolPassword: { type: new GraphQLNonNull(GraphQLString) }
  },
  outputFields: {
    listContainer: {
      type: GraphQLListContainer,
      resolve: () => SharedListContainer
    }
  },
  mutateAndGetPayload: async ({hostEmail, senderEmail, hostMessage, senderMessage, recipientIds, toolPassword}, {rootValue}) => {
    adminRequired(rootValue)

    // TODO: remove this goofy protection when the tool is ready
    // for all admins to use it.
    if (toolPassword !== 'solidarity') {
      throw new GraphQLError({
        status: 401,
        message: 'Incorrect password for this tool.'
      })
    }

    let comms = []

    await knex.transaction(async (trx) => {
      for (let i = 0; i < recipientIds.length; i++) {
       let personId = fromGlobalId(recipientIds[i]).id
       let person = await rootValue.loaders.bsdPeople.load(personId)
       let recipientEmail = await getPrimaryEmail(person)

        await Mailgun.sendAdminEventInvite(
          {
            hostAddress: hostEmail,
            senderAddress: senderEmail,
            hostMessage: hostMessage,
            senderMessage: senderMessage,
            //recipientAddress: recipientEmail
            recipientAddress: adminEmail
          },
          false      // debugging on or off?
        )

        let comm = await knex.insertAndFetch(
          'communications',
          {
            person_id: personId,
            type: 'EMAIL'
          },
          {transaction: trx}
        )

        comms.push(comm)
      }
    })

    return comms
  }
})

const GraphQLCreateCallAssignment = mutationWithClientMutationId({
  name: 'CreateCallAssignment',
  inputFields: {
    name: { type: new GraphQLNonNull(GraphQLString) },
    intervieweeGroup: { type: new GraphQLNonNull(GraphQLString) },
    surveyId: { type: new GraphQLNonNull(GraphQLInt) },
    renderer: { type: new GraphQLNonNull(GraphQLString) },
    processors: { type: new GraphQLList(GraphQLString) },
    instructions: { type: GraphQLString },
    startDate: { type: GraphQLDate },
    endDate: { type: GraphQLDate },
    callerGroupId: { type: GraphQLString }
  },
  outputFields: {
    listContainer: {
      type: GraphQLListContainer,
      resolve: () => SharedListContainer
    }
  },
  mutateAndGetPayload: async ({name, intervieweeGroup, surveyId, renderer, processors, instructions, startDate, endDate, callerGroupId}, {rootValue}) => {
    adminRequired(rootValue)
    let groupText = intervieweeGroup
    let group = null
    let survey = null
    return knex.transaction(async (trx) => {
      let underlyingSurvey = await knex('bsd_surveys')
        .transacting(trx)
        .where('signup_form_id', surveyId)
        .first()

      if (!underlyingSurvey) {
        try {
          let BSDSurveyResponse = await BSDClient.getForm(surveyId)
          let model = modelFromBSDResponse(BSDSurveyResponse, 'bsd_surveys')
          let BSDSurveyFieldsResponse = await BSDClient.listFormFields(surveyId)
          underlyingSurvey = await knex.insertAndFetch('bsd_surveys', model, {transaction: trx, idField: 'signup_form_id'})
          let fieldInsertionPromises = BSDSurveyFieldsResponse.map(async (field) => {
            let model = modelFromBSDResponse(field, 'bsd_survey_fields')
            let dbField = await knex('bsd_survey_fields').where('signup_form_field_id', model.signup_form_field_id).first()
            return dbField || knex('bsd_survey_fields').insert(model)
          })

          await Promise.all(fieldInsertionPromises);
        } catch (err) {
          if (err && err.response && err.response.statusCode === 409)
            throw new GraphQLError({
              status: 400,
              message: 'Provided survey ID does not exist in BSD.'
            })
          else
            throw err
        }
      }

      survey = await knex.insertAndFetch('gc_bsd_surveys', {
          signup_form_id: surveyId,
          processors: processors
        }, {transaction: trx})

      if (/^\d+$/.test(groupText)) {
        let underlyingGroup = await knex('bsd_groups')
          .transacting(trx)
          .where('cons_group_id', groupText)
          .first()

        if (!underlyingGroup) {
          try {
            let BSDGroupResponse = await BSDClient.getConstituentGroup(groupText)
            let model = modelFromBSDResponse(BSDGroupResponse, 'bsd_groups')
            underlyingGroup = await knex.insertAndFetch('bsd_groups', model, {transaction: trx, idField: 'cons_group_id'})
          } catch (err) {
            if (err && err.response && err.response.statusCode === 409)
              throw new GraphQLError({
                status: 400,
                message: 'Provided group ID does not exist in BSD.'
              })
            else
              throw err
          }
        }

        let consGroupID = groupText
        group = await knex('gc_bsd_groups')
          .transacting(trx)
          .where('cons_group_id', consGroupID)
          .first()

        if (!group)
          group = await knex.insertAndFetch('gc_bsd_groups', {
            'cons_group_id': consGroupID,
          }, {transaction: trx})
      }
      else {
        let query = groupText
        query = query.toLowerCase().trim().replace(/;*$/, '')

        if (query.indexOf('drop') !== -1)
          throw new GraphQLError({
            status: 400,
            message: 'Cannot use DROP in your SQL'
          })

        if (query !== EVERYONE_GROUP) {
          let limitedQuery = query
          if (query.indexOf('order by') === -1)
            limitedQuery = limitedQuery + ' order by cons_id'
          limitedQuery = `${limitedQuery} limit 1 offset 0`
          try {
            await knex.raw(limitedQuery)
          } catch (ex) {
            let error = `Invalid SQL query: ${ex.message}`
            throw new GraphQLError({
              status: 400,
              message: error
            })
          }
        }

        group = await knex('gc_bsd_groups')
          .transacting(trx)
          .where('query', query)
          .first()

        if (!group)
          group = await knex.insertAndFetch('gc_bsd_groups', {
              query: query
            }, {transaction: trx})
      }

      startDate = startDate || new Date()
      callerGroupId = callerGroupId ? fromGlobalId(callerGroupId).id : null

      return knex.insertAndFetch('bsd_call_assignments', {
          name: name,
          renderer: renderer,
          instructions: instructions,
          interviewee_group: group.id,
          gc_bsd_survey_id: survey.id,
          start_dt: startDate,
          end_dt: endDate,
          caller_group: callerGroupId
        }, {transaction: trx});
    })
  }
})

let RootMutation = new GraphQLObjectType({
  name: 'RootMutation',
  fields: () => ({
    editEvents: GraphQLEditEvents,
    submitCallSurvey: GraphQLSubmitCallSurvey,
    createCallAssignment: GraphQLCreateCallAssignment,
    deleteEvents: GraphQLDeleteEvents,
    createAdminEventEmail: GraphQLCreateAdminEventEmail
  })
})

let RootQuery = new GraphQLObjectType({
  name: 'RootQuery',
  fields: () => ({
    // This wrapper is necessary because relay does not support handling connection types in the root query currently. See https://github.com/facebook/relay/issues/112
    listContainer: {
      type: GraphQLListContainer,
      resolve: (parent, _, {rootValue}) => {
        adminRequired(rootValue)
        return SharedListContainer
      }
    },
    currentUser: {
      type: GraphQLUser,
      resolve: async (parent, _, {rootValue}) => {
        authRequired(rootValue)
        return rootValue.user
      }
    },
    callAssignment: {
      type: GraphQLCallAssignment,
      args: {
        id: { type: new GraphQLNonNull(GraphQLString) }
      },
      resolve: async (root, {id}, {rootValue}) => {
        authRequired(rootValue)
        let localId = fromGlobalId(id).id
        return rootValue.loaders.bsdCallAssignments.load(localId)
      }
    },
    event: {
      type: GraphQLEvent,
      args: {
        id: { type: new GraphQLNonNull(GraphQLString) }
      },
      resolve: async (root, {id}, {rootValue}) => {
        authRequired(rootValue)
        let localId = fromGlobalId(id).id
        return rootValue.loaders.bsdEvents.load(localId)
      }
    },
    node: nodeField
  })
})

export let Schema = new GraphQLSchema({
  query: RootQuery,
  mutation: RootMutation
})
