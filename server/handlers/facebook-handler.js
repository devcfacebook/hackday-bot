'use strict'

const config = require('../../config')
const Wreck = require('../lib/wreck-promise')

const _ = require('lodash'),
  Boom = require('boom'),
  Logger = require('bucker').createLogger({
    name: 'facebook-handler',
    console: config.get('/logger/options/console')
  })

const templates = require('../templates'),
  facebook = require('../lib/facebook')

const aiUri = config.get('/ai/uri')
const jokesUri = config.get('/random/jokes')
const rainUri = config.get('/random/rain')

// Incoming events handling
const incoming = (event) => {

  const senderID = event.sender.id
  const recipientID = event.recipient.id
  const timeOfMessage = event.timestamp
  const message = event.message
  const postback = event.postback
  const attachments = message && message.attachments

  if (!message && !postback && !attachments) {
    return Logger.error('Webhook received unknown event: ', event)
  }

  Logger.info('Received message for user %d and page %d at %d with message: %j', senderID, recipientID, timeOfMessage, message)

  const messageId = message && message.mid
  const messageText = postback && postback.title ||
    attachments && `upload_${attachments[0].type}` ||
    message && message.text
  const payload = postback && postback.payload
  const attachmenUrl = attachments && `${attachments[0].payload.url}`

  if (attachments) {
    return facebook.response(templates.text.create(senderID, `Message with attachment received (${messageText})`)).then(() => {
      if (messageText == 'upload_location') {
        let coordinates = attachments[0].payload.coordinates
        facebook.response(templates.text.create(senderID, `Coordinates: ${coordinates.lat},${coordinates.long}`))
      } else {
        facebook.response(templates.text.create(senderID, `File Url: ${attachmenUrl}`))
      }
    })
  } else if (payload) {
    return facebook.response(templates.text.create(senderID, `${messageText} (${payload})`))
  } else if (messageText) {
    // If we receive a text message, check to see if it matches a keyword
    // and send back the template example. Otherwise, just echo the text we received.
    switch (messageText) {
      case 'hi':
      case 'hello':
      case 'hola':
        return facebook.getUser(senderID).then((user) => {
          facebook.response(templates.text.create(senderID, `${messageText} ${user.first_name}! (${user.id})`)).then(() => {
            facebook.response(templates.image.picture(senderID, user.profile_pic))
          })
        })
      case 'generic':
        return facebook.response(templates.generic.create(senderID))
      case 'button':
        return facebook.response(templates.button.create(senderID))
      case 'image':
        return facebook.response(templates.image.create(senderID))
      default:
        // Here is the magic
        return Wreck.get(`${aiUri}?q=${messageText}`, {}).then(result => {
          const {body} = result
          if (body.intent.confidence >= 0.5 && body.intent.name !== 'none') {
            switch (body.intent.name) {
              case 'chiste':
                facebook.response(templates.text.create(senderID, 'Ok... te contaré un chiste:')).then(() => {
                  Wreck.get(jokesUri, {}).then(result => {
                    const {body} = result
                    facebook.response(templates.text.create(senderID, body.value.joke)).then(_ => {
                      facebook.response(templates.image.create(senderID))
                    })
                  }).catch(_ => {
                    facebook.response(templates.image.create(senderID, 'No estoy de humor...'))
                  })
                })
                break
              case 'consejos-amor':
                facebook.response(templates.text.create(senderID, 'Está imagen representa lo que siento... :(')).then(() => {
                  facebook.response(templates.image.picture(senderID, rainUri))
                })
                break
              default:
                facebook.response(templates.text.create(senderID, body.intent.name))
            }
          } else {
            facebook.response(templates.text.create(senderID, 'Aún no puedo ayudarte con esto... :('))
          }
        }).catch(error => {
          Logger.error(error)
          facebook.response(templates.text.create(senderID, messageText))
        })
    }
  }

}

const webhook = {
  validation: (request, reply) => {

    // get verify token from configuration
    const token = config.get('/messenger/token')

    // parse query params
    const hub = {
      mode: request.query['hub.mode'],
      verifyToken: request.query['hub.verify_token'],
      challenge: request.query['hub.challenge']
    }

    // validate connection
    if (hub.mode === 'subscribe' && hub.verifyToken === token) {
      Logger.info('Validating webhook OK')
      reply(hub.challenge)
    } else {
      Logger.error('Failed validation. Make sure the validation tokens match.')
      reply(Boom.forbidden('Failed validation. Make sure the validation tokens match.'))
    }

  },
  messages: (request, reply) => {

    const data = request.payload

    // Make sure this is a page subscription
    if (_.has(data, 'object') && _.isEqual(_.get(data, 'object'), 'page')) {

      // response to facebook OK
      reply({})

      // Iterate over each entry - there may be multiple if batched
      _.each(data.entry, (entry) => {

        // Iterate over each messaging event
        _.each(entry.messaging, (event) => {

          Logger.debug(`Messenger event: %j`, event)
          incoming(event)

        })
      })

    } else {
      reply(Boom.badRequest('Payload data'))
    }

  }
}

module.exports = {
  webhook
}
