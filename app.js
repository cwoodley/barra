#!/usr/bin/env node
/*
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
"use strict";

const bodyParser = require("body-parser"),
  config = require("config"),
  crypto = require("crypto"),
  express = require("express"),
  https = require("https"),
  request = require("request"),
  fetch = require("node-fetch");

  const {promisify} = require('util')
  const fs = require('fs')
  const readFileAsync = promisify(fs.readFile)

var app = express();
app.set("port", process.env.PORT || 5000);
app.set("view engine", "ejs");
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static("public"));

/*
 * Be sure to setup your config values before running this code. You can
 * set them using environment variables or modifying the config file in /config.
 *
 */

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = process.env.MESSENGER_APP_SECRET
  ? process.env.MESSENGER_APP_SECRET
  : config.get("appSecret");

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = process.env.MESSENGER_VALIDATION_TOKEN
  ? process.env.MESSENGER_VALIDATION_TOKEN
  : config.get("validationToken");

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = process.env.MESSENGER_PAGE_ACCESS_TOKEN
  ? process.env.MESSENGER_PAGE_ACCESS_TOKEN
  : config.get("pageAccessToken");

// URL where the app is running (include protocol). Used to point to scripts and
// assets located at this address.
const SERVER_URL = process.env.SERVER_URL
  ? process.env.SERVER_URL
  : config.get("serverURL");

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  console.error("Missing config values");
  process.exit(1);
}

/*
 * Use your own validation token. Check that the token used in the Webhook
 * setup is the same token used here.
 *
 */
app.get("/webhook", function(req, res) {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VALIDATION_TOKEN
  ) {
    console.log("Validating webhook");
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);
  }
});

/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page.
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post("/webhook", function(req, res) {
  var data = req.body;

  // Make sure this is a page subscription
  if (data.object == "page") {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          receivedAccountLink(messagingEvent);
        } else {
          console.log(
            "Webhook received unknown messagingEvent: ",
            messagingEvent
          );
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know you've
    // successfully received the callback. Otherwise, the request will time out.
    res.sendStatus(200);
  }
});

/*
 * This path is used for account linking. The account linking call-to-action
 * (sendAccountLinking) is pointed to this URL.
 *
 */
app.get("/authorize", function(req, res) {
  var accountLinkingToken = req.query.account_linking_token;
  var redirectURI = req.query.redirect_uri;

  // Authorization Code should be generated per user by the developer. This will
  // be passed to the Account Linking callback.
  var authCode = "1234567890";

  // Redirect users to this URI on successful login
  var redirectURISuccess = redirectURI + "&authorization_code=" + authCode;

  res.render("authorize", {
    accountLinkingToken: accountLinkingToken,
    redirectURI: redirectURI,
    redirectURISuccess: redirectURISuccess
  });
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from
 * the App Dashboard, we can verify the signature that is sent with each
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split("=");
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto
      .createHmac("sha1", APP_SECRET)
      .update(buf)
      .digest("hex");

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to
 * Messenger" plugin, it is the 'data-ref' field. Read more at
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger'
  // plugin.
  var passThroughParam = event.optin.ref;

  console.log(
    "Received authentication for user %d and page %d with pass " +
      "through param '%s' at %d",
    senderID,
    recipientID,
    passThroughParam,
    timeOfAuth
  );

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  sendTextMessage(senderID, "Authentication successful");
}

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message'
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've
 * created. If we receive a message with an attachment (image, video, audio),
 * then we'll simply confirm that we've received the attachment.
 *
 */
async function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log(
    "Received message for user %d and page %d at %d with message:",
    senderID,
    recipientID,
    timeOfMessage
  );
  console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    // Just logging message echoes to console
    console.log(
      "Received echo for message %s and app %d with metadata %s",
      messageId,
      appId,
      metadata
    );
    return;
  } else if (quickReply) {

    function generateMessageData(documents, id) {
      return {
        recipient: { id },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "generic",
              elements: documents.map(function(document) {
                return {
                  title: document.homepageHead !== "undefined" && document.homepageHead !== "null" ? document.homepageHead : '',
                  subtitle: document.homepageTeaser !== "undefined" ? document.homepageTeaser : '',
                  item_url: document._self !== "undefined" ? document._self : '',
                  image_url: document.posterImage ? document.posterImage.reference : document.mainImage ? document.mainImage.reference : '',
                };
              })
            }
          }
        }
      };
    }
    switch (quickReply.payload) {
      case "LATEST_CRICKET_PAYLOAD":
        fetch(
          `https://gazette.swmdigital.io/curation-api/the-west/publication?page=1&page_size=5&includeFuture=true&topics=sport/cricket`
        )
          .then(res => res.json())
          .then(json => {
            return generateMessageData(json.documents, senderID);
          })
          .then(messageData => {
              sendLoadingMessage(senderID)
              callSendAPI(messageData)
            })
          .catch((error, recipientId) => {
            console.log(error);
            const errorMessage = {
              recipient: { id: recipientId },
              sender_action: "typing_off"
            };
            callSendAPI(errorMessage);
          });
          break;
      case "LATEST_SCORCHERS_PAYLOAD":
        fetch(
          `https://gazette.swmdigital.io/curation-api/the-west/publication?page=1&page_size=5&includeFuture=true&topics=sport/perth-scorchers`
        )
          .then(res => res.json())
          .then(json => {
            return generateMessageData(json.documents, senderID);
          })
          .then(messageData => {
            sendLoadingMessage(senderID)
            callSendAPI(messageData)
          })
          .catch((error, recipientId) => {
            console.log(error);
            const errorMessage = {
              recipient: { id: recipientId },
              sender_action: "typing_off"
            };
            callSendAPI(errorMessage);
          });
          break;
      case "LATEST_BBL_PAYLOAD":
        fetch(
          `https://gazette.swmdigital.io/curation-api/the-west/publication?page=1&page_size=5&includeFuture=true&topics=sport/big-bash-league`
        )
          .then(res => res.json())
          .then(json => {
            return generateMessageData(json.documents, senderID);
          })
          .then(messageData => {
            sendLoadingMessage(senderID)
            callSendAPI(messageData)
          })
          .catch((error, recipientId) => {
            console.log(error);
            const errorMessage = {
              recipient: { id: recipientId },
              sender_action: "typing_off"
            };
            callSendAPI(errorMessage);
          });
          break;
      case "LATEST_WOMENS_PAYLOAD":
        fetch(
          `https://gazette.swmdigital.io/curation-api/the-west/publication?page=1&page_size=5&includeFuture=true&topics=sport/womens-cricket`
        )
          .then(res => res.json())
          .then(json => {
            return generateMessageData(json.documents, senderID);
          })
          .then(messageData => {
            sendLoadingMessage(senderID)
            callSendAPI(messageData)
          })
          .catch((error, recipientId) => {
            console.log(error);
            const errorMessage = {
              recipient: { id: recipientId },
              sender_action: "typing_off"
            };
            callSendAPI(errorMessage);
          });
          break;
      case "LATEST_AUST_PAYLOAD":
        fetch(
          `https://gazette.swmdigital.io/curation-api/the-west/publication?page=1&page_size=5&includeFuture=true&topics=sport/australian-cricket-team`
        )
          .then(res => res.json())
          .then(json => {
            return generateMessageData(json.documents, senderID);
          })
          .then(messageData => {
            sendLoadingMessage(senderID)
            callSendAPI(messageData)
          })
          .catch((error, recipientId) => {
            console.log(error);
            const errorMessage = {
              recipient: { id: recipientId },
              sender_action: "typing_off"
            };
            callSendAPI(errorMessage);
          });
          break;
      case "LATEST_ASHES_PAYLOAD":
        fetch(
          `https://gazette.swmdigital.io/curation-api/the-west/publication?page=1&page_size=5&includeFuture=true&topics=sport/the-ashes`
        )
          .then(res => res.json())
          .then(json => {
            return generateMessageData(json.documents, senderID);
          })
          .then(messageData => {
            sendLoadingMessage(senderID)
            callSendAPI(messageData)
          })
          .catch((error, recipientId) => {
            console.log(error);
            const errorMessage = {
              recipient: { id: recipientId },
              sender_action: "typing_off"
            };
            callSendAPI(errorMessage);
          });
          break;
      case "LATEST_IPL_PAYLOAD":
        fetch(
          `https://gazette.swmdigital.io/curation-api/the-west/publication?page=1&page_size=5&includeFuture=true&topics=sport/indian-premier-league`
        )
          .then(res => res.json())
          .then(json => {
            return generateMessageData(json.documents, senderID);
          })
          .then(messageData => {
            sendLoadingMessage(senderID)
            callSendAPI(messageData)
          })
          .catch((error, recipientId) => {
            console.log(error);
            const errorMessage = {
              recipient: { id: recipientId },
              sender_action: "typing_off"
            };
            callSendAPI(errorMessage);
          });
          break;
      case "LATEST_WORLD_PAYLOAD":
        fetch(
          `https://gazette.swmdigital.io/curation-api/the-west/publication?page=1&page_size=5&includeFuture=true&topics=sport/cricket-world-cup`
        )
          .then(res => res.json())
          .then(json => {
            return generateMessageData(json.documents, senderID);
          })
          .then(messageData => {
            sendLoadingMessage(senderID)
            callSendAPI(messageData)
          })
          .catch((error, recipientId) => {
            console.log(error);
            const errorMessage = {
              recipient: { id: recipientId },
              sender_action: "typing_off"
            };
            callSendAPI(errorMessage);
          });
          break;
    }

    return;
  }

  sendReadReceipt(senderID);

  if (messageText) {
    const downCaseMessage = messageText.replace(/[^\w\s]/gi, '').trim().toLowerCase()
    const regex = /^tell me more about (.*)/g;
    const latestRegex = /^(.*)latest(.*)/g;
    const nextMatchRegex = /^(.*)next match(.*)/g;

    const playerInfo = [/^tell me more about (.*)/g, /^tell me about (.*)/g, /^who is (.*)/g]
    const explainThis = [/^what is a (.*)/g, /^what does (.*) mean/g]
    const regex2 = /^(.*)latest(.*)/g;

    playerInfo.forEach(expression => {
      if (downCaseMessage.match(expression)) {
        const searchFor = expression.exec(downCaseMessage)

        sendPlayerMessage(senderID, searchFor[1])
      }
    })

    explainThis.forEach(expression => {
      if (downCaseMessage.match(expression)) {
        const searchFor = expression.exec(downCaseMessage)

        sendExplainerMessage(senderID, searchFor[1])
      }
    })

    if (downCaseMessage === 'tell me a joke') {
      sendJokeMessage(senderID)
    }
    if (downCaseMessage.match(latestRegex)) {
      var messageData = {
        recipient: {
          id: senderID
        },
        message: {
          text: "Select a Topic",
          quick_replies: [
            {
              content_type: "text",
              title: "Cricket",
              payload: "LATEST_CRICKET_PAYLOAD"
            },
            {
              content_type: "text",
              title: "Scorchers",
              payload: "LATEST_SCORCHERS_PAYLOAD"
            },
            {
              content_type: "text",
              title: "Women’s Cricket",
              payload: "LATEST_WOMENS_PAYLOAD"
            },
            {
              content_type: "text",
              title: "Australian Cricket Team",
              payload: "LATEST_AUST_PAYLOAD"
            },
            {
              content_type: "text",
              title: "The Ashes",
              payload: "LATEST_ASHES_PAYLOAD"
            },
            {
              content_type: "text",
              title: "Big Bash League",
              payload: "LATEST_BBL_PAYLOAD"
            },
            {
              content_type: "text",
              title: "Cricket World Cup",
              payload: "LATEST_WORLD_PAYLOAD"
            },
            {
              content_type: "text",
              title: "Indian Premier League",
              payload: "LATEST_IPL_PAYLOAD"
            }
          ]
        }
      };

      callSendAPI(messageData);

    }

    if (downCaseMessage.match(nextMatchRegex)) {
      var messageData = {
        "recipient":{
          "id": senderID
        },
        "message": {
          "attachment": {
            "type": "template",
            "payload": {
              "template_type": "list",
              "top_element_style": "LARGE",
              "elements": [
                {
                  "title": "Cricket",
                  "image_url": "https://images.thewest.com.au/publication/B881022500Z/1542262499128_GDO1U9KIB.1-2.jpg?imwidth=1024",
                },
                {
                  "title": 'Gillette T20s v India, First T20',
                  "subtitle": `Wednesday 21 Nov 2018 5:50 PM. The Gabba, Brisbane`,
                },
                {
                  "title": 'Gillette T20s v India, Second T20',
                  "subtitle": `23 Nov 2018 @ 6:50 PM. MCG, Melbourne`,
                },
                {
                  "title": 'Gillette T20s v India, Third T20',
                  "subtitle": `25 Nov 2018 6:50 PM. SCG, Sydney`,
                }

              ],
              "buttons": [
                {
                  "title": "More on The West",
                  "type": "web_url",
                  "url": "https://thewest.com.au/sport/cricket/which-cricket-matches-are-on-seven-this-summer-complete-free-to-air-tv-guide-for-big-bash-league-and-internationals-ng-b881022500z"
                }
              ]
            }
          }
        }
      };

      callSendAPI(messageData);
    }


  } else if (messageAttachments) {
    sendTextMessage(senderID, "Message with attachment received");
  }
}

/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      console.log(
        "Received delivery confirmation for message ID: %s",
        messageID
      );
    });
  }

  console.log("All message before %d were delivered.", watermark);
}

/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 *
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  // The 'payload' param is a developer-defined field which is set in a postback
  // button for Structured Messages.
  var payload = event.postback.payload;

  console.log(
    "Received postback for user %d and page %d with payload '%s' " + "at %d",
    senderID,
    recipientID,
    payload,
    timeOfPostback
  );

  // When a postback is called, we'll send a message back to the sender to
  // let them know it was successful
  sendTextMessage(senderID, "Postback called");
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 *
 */
function receivedMessageRead(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  // All messages before watermark (a timestamp) or sequence have been seen.
  var watermark = event.read.watermark;
  var sequenceNumber = event.read.seq;

  console.log(
    "Received message read event for watermark %d and sequence " + "number %d",
    watermark,
    sequenceNumber
  );
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 *
 */
function receivedAccountLink(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  var status = event.account_linking.status;
  var authCode = event.account_linking.authorization_code;

  console.log(
    "Received account link event with for user %d with status %s " +
      "and auth code %s ",
    senderID,
    status,
    authCode
  );
}

/*
 * If users came here through testdrive, they need to configure the server URL
 * in default.json before they can access local resources likes images/videos.
 */
function requiresServerURL(next, [recipientId, ...args]) {
  if (SERVER_URL === "to_be_set_manually") {
    var messageData = {
      recipient: {
        id: recipientId
      },
      message: {
        text: `
We have static resources like images and videos available to test, but you need to update the code you downloaded earlier to tell us your current server url.
1. Stop your node server by typing ctrl-c
2. Paste the result you got from running "lt —port 5000" into your config/default.json file as the "serverURL".
3. Re-run "node app.js"
Once you've finished these steps, try typing “video” or “image”.
        `
      }
    };

    callSendAPI(messageData);
  } else {
    next.apply(this, [recipientId, ...args]);
  }
}

function sendHiMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: `
Congrats on setting up your Messenger Bot!

Right now, your bot can only respond to a few words. Try out "quick reply", "typing on", "button", or "image" to see how they work. You'll find a complete list of these commands in the "app.js" file. Anything else you type will just be mirrored until you create additional commands.

For more details on how to create commands, go to https://developers.facebook.com/docs/messenger-platform/reference/send-api.
      `
    }
  };

  callSendAPI(messageData);
}

function sendLoadingMessage(recipientId) {
  const loadingMessage = {
    recipient: { id: recipientId },
    sender_action: "typing_on"
  };

  callSendAPI(loadingMessage);
}

function sendPlayerMessage(recipientId, player) {

  sendLoadingMessage(recipientId)
  console.log('ok!')

  fetch(`https://gazette.swmdigital.io/curation-api/the-west/publication?page=1&page_size=100&includeFuture=true&idOrKeyword=${player}`)
  .then(res => res.json())

  .then(json => {
    const publicationId = json.documents[0]
    const publication =
      {
        title: publicationId.homepageHead,
        subtitle: publicationId.homepageTeaser,
        url: `https://thewest.com.au/${publicationId.slug}`
      }
    return publication
  })
  .then(publication => {
    const messageData = {
      recipient: {id: recipientId},
      message: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'open_graph',

            elements: [
              {
                url: publication.url,
                buttons: [{
                  type: 'web_url',
                  url: publication.url,
                  title: 'read more',
                }],
              }
            ]
          }
        }
      }
    }

    return messageData
  })
  .then(messageData => callSendAPI(messageData))
  .catch((error, recipientId) => {
    console.log(error)
    const errorMessage = {
      recipient: {id:recipientId},
      sender_action: 'typing_off'
    }

    callSendAPI(errorMessage)
  })
}

function sendExplainerMessage(recipientId, explainer) {
  sendLoadingMessage(recipientId)

  readFileAsync(`${__dirname}/data/explainers.json`, {encoding: 'utf8'})
  .then(contents => {
    const obj = JSON.parse(contents)
    return obj
  })
  .then(obj => {
    const definition = getDefinition(obj, upperCase(explainer))
    return definition
  })
  .then(definition => {
    const messageData = {
        recipient: {id:recipientId},
        message: {
          text: definition[0].definition
        }
      }

      console.log(messageData)

    return messageData
  })
  .then(messageData => {
    console.log('sending message...')
    callSendAPI(messageData)
  })
  .catch(error => {
    console.log(error)
  })
}

function sendJokeMessage(recipientId) {
  sendLoadingMessage(recipientId)
  const articleNumber = Math.floor(Math.random() * 9) + 1;

  readFileAsync(`${__dirname}/data/jokes.json`, {encoding: 'utf8'})
  .then(contents => {
    const obj = JSON.parse(contents)
    return obj
  })
  .then(definition => {
    console.log('asking question number',articleNumber)
    const messageData = {
        recipient: {id:recipientId},
        message: {
          text: `${definition[articleNumber].question}

${definition[articleNumber].answer} 😂




--------------
This awful joke is brought to you by TABTouch`
        }
      }

      console.log(messageData)

    return messageData
  })
  .then(messageData => {
    console.log('sending message...')
    callSendAPI(messageData)
  })
  .catch(error => {
    console.log(error)
  })
}

function upperCase(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

function getDefinition(data, lookingFor) {
  const definition = data.filter(
    item => {
      if (item.term === lookingFor) {
        return item.definition
      }
    }
  )

  return definition
}

function sendRandomNewsMessage(recipientId) {
  const articleNumber = Math.floor(Math.random() * 10) + 1;

  fetch("https://content.thewest.com.au/topic/sport/cricket")
    .then(res => res.json())
    .then(json => {
      const publicationId = json.publications[articleNumber];
      const publication = {
        title: publicationId.homepageHead,
        subtitle: publicationId.homepageTeaser,
        url: `https://thewest.com.au/${publicationId.slug}`
      };
      return publication;
    })
    .then(publication => {
      const messageData = {
        recipient: { id: recipientId },
        message: {
          attachment: {
            template: "generic",

            payload: {
              template_type: "generic",
              elements: {
                title: publication.title,
                subtitle: publication.subtitle,
                buttons: [
                  {
                    type: "element_share",
                    share_contents: {
                      attachment: {
                        type: "template",
                        payload: {
                          template_type: "generic",
                          elements: [
                            {
                              title: "Check out this weird story",
                              default_action: {
                                type: "web_url",
                                url: publication.url
                              },
                              buttons: [
                                {
                                  type: "web_url",
                                  url: publication.url,
                                  title: "Read more"
                                }
                              ]
                            }
                          ]
                        }
                      }
                    }
                  }
                ]
              }
            }
          }
        }
      };
      return messageData;
    })
    .then(messageData => callSendAPI(messageData))
    .catch((error, recipientId) => {
      console.log(error);
      const errorMessage = {
        recipient: { id: recipientId },
        sender_action: "typing_off"
      };

      callSendAPI(errorMessage);
    });
}

/*
 * Send a read receipt to indicate the message has been read
 *
 */
function sendReadReceipt(recipientId) {
  console.log("Sending a read receipt to mark message as seen");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "mark_seen"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
  console.log("Turning typing indicator on");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_on"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
  console.log("Turning typing indicator off");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_off"
  };

  callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll
 * get the message id in a response
 *
 */
function callSendAPI(messageData) {
  request(
    {
      uri: "https://graph.facebook.com/v2.6/me/messages",
      qs: { access_token: PAGE_ACCESS_TOKEN },
      method: "POST",
      json: messageData
    },
    function(error, response, body) {
      if (!error && response.statusCode == 200) {
        var recipientId = body.recipient_id;
        var messageId = body.message_id;

        if (messageId) {
          console.log(
            "Successfully sent message with id %s to recipient %s",
            messageId,
            recipientId
          );
        } else {
          console.log(
            "Successfully called Send API for recipient %s",
            recipientId
          );
        }
      } else {
        console.error(
          "Failed calling Send API",
          response.statusCode,
          response.statusMessage,
          body.error
        );
      }
    }
  );
}

// Start server
// Webhooks must be available via SSL with a certificate signed by a valid
// certificate authority.
app.listen(app.get("port"), function() {
  console.log("Node app is running on port", app.get("port"));
});

module.exports = app;
