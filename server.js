'use strict';

// Module imports
let restify = require('restify')
  , express = require('express')
  , http = require('http')
  , bodyParser = require('body-parser')
  , async = require('async')
  , _ = require('lodash')
  , log = require('npmlog-ts')
  , moment = require('moment')
  , commandLineArgs = require('command-line-args')
  , getUsage = require('command-line-usage')
  , cors = require('cors')
;

// Instantiate classes & servers
const wsURI        = '/socket.io'
    , infoURI      = '/info'
    , demozonesURI = '/demozones'
    , resetURI     = '/reset'
;
const WS = "WS"
    , LX = "LX"
    , DB = "DB"
;
// ************************************************************************
// Main code STARTS HERE !!
// ************************************************************************

log.stream = process.stdout;
log.timestamp = true;

// Main handlers registration - BEGIN
// Main error handler
process.on('uncaughtException', function (err) {
  log.info("","Uncaught Exception: " + err);
  log.info("","Uncaught Exception: " + err.stack);
});
// Detect CTRL-C
process.on('SIGINT', function() {
  log.info("","Caught interrupt signal");
  log.info("","Exiting gracefully");
  process.exit(2);
});
// Main handlers registration - END

// Initialize input arguments
const optionDefinitions = [
  { name: 'dbhost', alias: 'd', type: String },
  { name: 'eventserver', alias: 's', type: String },
  { name: 'pinginterval', alias: 'i', type: Number },
  { name: 'pingtimeout', alias: 't', type: Number },
  { name: 'help', alias: 'h', type: Boolean },
  { name: 'verbose', alias: 'v', type: Boolean, defaultOption: false }
];

const sections = [
  {
    header: 'IoT Racing - SSL Event Server for Live Experience',
    content: 'Event Server for IoT Racing events'
  },
  {
    header: 'Options',
    optionList: [
      {
        name: 'dbhost',
        typeLabel: '[underline]{ipaddress:port}',
        alias: 'd',
        type: String,
        description: 'DB setup server IP address/hostname and port'
      },
      {
        name: 'eventserver',
        typeLabel: '[underline]{ipaddress}',
        alias: 's',
        type: String,
        description: 'socket.io server IP address/hostname (no port is needed)'
      },
      {
        name: 'pinginterval',
        typeLabel: '[underline]{milliseconds}',
        alias: 'i',
        type: Number,
        description: 'Ping interval in milliseconds for event clients'
      },
      {
        name: 'pingtimeout',
        typeLabel: '[underline]{milliseconds}',
        alias: 't',
        type: Number,
        description: 'Ping timeout in milliseconds for event clients'
      },
      {
        name: 'verbose',
        alias: 'v',
        description: 'Enable verbose logging.'
      },
      {
        name: 'help',
        alias: 'h',
        description: 'Print this usage guide.'
      }
    ]
  }
]
let options = undefined;

try {
  options = commandLineArgs(optionDefinitions);
} catch (e) {
  console.log(getUsage(sections));
  console.log(e.message);
  process.exit(-1);
}

if (!options.dbhost || !options.eventserver) {
  console.log(getUsage(sections));
  process.exit(-1);
}

if (options.help) {
  console.log(getUsage(sections));
  process.exit(0);
}

log.level = (options.verbose) ? 'verbose' : 'info';

const pingInterval = process.env.PINGINTERVAL || 30000
    , pingTimeout  = process.env.PINGTIMEOUT  || 60000
    , RESTPORT     = process.env.PORT || 8080
    , URI = '/ords/pdb1/anki/demozone/zone/'
;

// REST engine initial setup

let client = restify.createJsonClient({
  url: 'https://' + options.dbhost,
  rejectUnauthorized: false,
  headers: {
    "content-type": "application/json"
  }
});

let demozones = _.noop();
let demozonesId = _.noop();
let cnxId = 0;
let ankiClients = [];
let lxClients   = [];
let ws = {};
const namespace = 'offtrack';

async.series([
    function(next) {
      client.get(URI, function(err, req, res, obj) {
        let jBody = JSON.parse(res.body);
        if (err) {
          next(err.message);
        } else if (!jBody.items || jBody.items.length == 0) {
          next("No demozones found. Aborting.");
        } else {
          demozones = jBody.items;
          demozonesId = _.map(jBody.items, 'id');
          log.info(DB, "Available demozones:%s", _.reduce(demozones, (str, e) => {
            return str + " " + e.name;
          }, ""));
          next(null);
        }
      });
    },
    function(next) {
      // Create single TSL Websocket server
      ws.port = RESTPORT;
      ws.app = express();
      ws.demozone = _.noop();
      ws.app.use(bodyParser.urlencoded({ extended: true }));
      ws.app.use(bodyParser.json());
      ws.app.use(cors());
      ws.server = http.createServer(ws.app);
      log.verbose(WS, "Creating WS with %d ping interval and %d ping timeout", pingInterval, pingTimeout);
      ws.io = require('socket.io')(ws.server, {'pingInterval': pingInterval, 'pingTimeout': pingTimeout});
      ws.io.on('connection', socket => {
        let demozone = socket.handshake.query.demozone;
        log.verbose(LX,"Client requesting to connect for demozone: '%s'", demozone);
        if (!isValid(demozone)) {
          log.error(LX, "Invalid or unknown demozone: '%s'. Disconnecting client", demozone);
          socket.disconnect(true);
          return;
        }
        let cnx =  {
          id: ++cnxId,
          demozone: demozone.toUpperCase(),
          timestampmilis: Date.now(),
          timestamp: moment().format("DD/MM/YYYY HH:mm:ss:SSS"),
          socket: socket
        }
        lxClients.push(cnx);
        log.info(LX,"Client connected and registered for demozone: '%s' and id: %d", cnx.demozone, cnx.id);
        socket.conn.on('heartbeat', () => {
          log.verbose(LX,'heartbeat');
        });
        socket.on('disconnect', () => {
          log.info(LX,"Socket disconnected for demozone '%s' with id %d", cnx.demozone, cnx.id);
          _.remove(lxClients, { 'id': cnx.id });
        });
        socket.on('error', err => {
          log.error(LX,"Error: " + err);
        });
      });
      ws.server.listen(ws.port, function() {
        log.info(WS,"Created server at port: " + ws.port);
        next(null);
      });
    },
    function(next) {
      async.eachSeries(demozones, (demozone,callback) => {
        let d = {
          demozone: demozone.id,
          name: demozone.name,
          port: (demozone.proxyport % 100) + 10000,
          events: 0,
          lastEvent: null
        };
        let serverURI = 'http://' + options.eventserver + ':' + d.port;
        log.info(d.name, "Connecting to server at: " + serverURI);
        d.socket = require('socket.io-client')(serverURI);
        d.socket.on('connect', () => {
          log.verbose(d.name,"[EVENT] connect");
          ankiClients.push(d);
        });
        d.socket.on('disconnect', () => {
          log.verbose(d.name,"[EVENT] Disconnect");
          _.remove(ankiClients, { 'demozone': demozone.id });
        });
        // OFFTRACK
        // [{"id":"14a7eca4-ec90-49f4-bba1-8a7cc34b4424","clientId":"d91c6c49-4ab1-44a6-b5a2-79eab32a2f1b","source":"$UBSYS-2","destination":"","priority":"MEDIUM","reliability":"BEST_EFFORT","eventTime":1488750699751,"sender":"","type":"DATA","properties":{},"direction":"FROM_IOTCS","receivedTime":1488750699751,"sentTime":1488750699808,"payload":{"format":"urn:oracle:iot:anki:exploration:event:offtrack","data":{"data_lap":3,"data_lastknowntrack":4,"msg_source":"AAAAAATVCIIA-A4","data_datetimestring":"17/02/01 16:45:17:421189","msg_destination":"","data_message":"Off Track","data_eventtime":1488750696235000000,"data_carname":"Thermo","data_datetime":0,"data_deviceid":"0000000051b9c6ae","data_raceid":17,"data_carid":"EB:EB:C4:8D:19:2D:01","msg_priority":"HIGHEST","msg_id":"19b7ebaf-f1bc-4236-994c-ae0acd97d943","data_demozone":"BARCELONA","data_racestatus":"RACING","msg_sender":""}}}]
        log.verbose(d.name, "Subscribing to namespace: %s", namespace);
        d.socket.on(namespace, function(msg, callback) {
          log.verbose(d.name, "OFFTRACK message received: " + JSON.stringify(msg));
          // send the message as-is to all LX websocket channel(s)
          let matches = _.filter(lxClients, { 'demozone': d.demozone });
          log.info(d.name, "'%s' event received and forwarded to %d LX currently connected clients", namespace, matches.length);
          if (matches.length > 0) {
            d.events++;
            d.lastEvent = moment().format("DD/MM/YYYY HH:mm:ss:SSS");
            _.forEach(matches, (client) =>  {
              client.socket.emit(namespace, msg);
            });
          } else {
            log.info(d.name, "'%s' event received but no LX client(s) currently connected. Ignoring event", namespace);
          }
        });
        callback(null);
      }, function(err) {
        next(null);
      });
    },
    function(next) {
      ws.app.get(infoURI, function(req,res) {
        res.status(200).send(_.flatMap(ankiClients, (n) => { return _.omit(n, ['demozone', 'port', 'socket']) }));
      });
      ws.app.get(demozonesURI, function(req,res) {
//        res.status(200).send(_.flatMap(ankiClients, (n) => { return _.map(_.omit(n, ['events', 'port', 'socket', 'lastEvent', 'name']), 'demozone') }));
        res.status(200).send(_.sortBy(_.map(_.flatMap(ankiClients, (n) => { return _.omit(n, ['events', 'port', 'socket', 'lastEvent', 'name']) }), 'demozone')));
      });
      next(null);
    }
], function(err, results) {
  if (err) {
    log.error("", err.message);
    process.exit(2);
  }
});

function isValid(demozone) {
  if (!demozone || !demozonesId || demozonesId.length === 0) {
    return false;
  }
  return demozonesId.indexOf(demozone.toUpperCase()) !== -1;
}
