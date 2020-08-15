const port = 2130;

function infiniteStream(
  encoding,
  sampleRateHertz,
  languageCode,
  streamingLimit
) {
  const chalk = require('chalk');
  const { Transform } = require('stream');

  const recorder = require('node-record-lpcm16');

  // Imports the Google Cloud client library
  const speech = require('@google-cloud/speech');

  //Require the express moule
  const express = require('express');

  //create a new express application
  const app = express();

  app.use(express.static(__dirname + '/node_modules'));
  app.get('/', function (req, res, next) {
    res.sendFile(__dirname + '/index.html');
  });

  //require the http module
  const http = require('http').createServer(app);

  // require the socket.io module
  const io = require('socket.io');

  const socket = io(http);

  // Creates a client
  const client = new speech.SpeechClient();

  // const encoding = 'LINEAR16';
  // const sampleRateHertz = 16000;
  // const languageCode = 'en-US';

  const request = {
    config: {
      encoding: encoding,
      sampleRateHertz: sampleRateHertz,
      languageCode: languageCode,
    },
    interimResults: false, // If you want interim results, set this to true
  };

  let recognizeStream = null;
  let restartCounter = 0;
  let audioInput = [];
  let lastAudioInput = [];
  let resultEndTime = 0;
  let isFinalEndTime = 0;
  let finalRequestEndTime = 0;
  let newStream = true;
  let bridgingOffset = 0;
  let lastTranscriptWasFinal = false;
  let socketSetup = false;

  function setupSocket() {
    if (!socketSetup) {
      socket.on('connection', (socket) => {
        console.log('Client Connected');
      });

      http.listen(port, () => console.log());

      socketSetup = true;
    }
  }

  function startStream() {
    // Setup socket
    setupSocket();

    // Clear current audioInput
    audioInput = [];

    // Initiate (Reinitiate) a recognize stream
    recognizeStream = client
      .streamingRecognize(request)
      .on('error', (err) => {
        if (err.code === 11) {
          // restartStream();
        } else {
          console.error('API request error ' + err);
        }
      })
      .on('data', speechCallback);

    // Restart stream when streamingLimit expires
    setTimeout(restartStream, streamingLimit);
  }

  const speechCallback = (stream) => {
    // Convert API result end time from seconds + nanoseconds to milliseconds
    resultEndTime =
      stream.results[0].resultEndTime.seconds * 1000 +
      Math.round(stream.results[0].resultEndTime.nanos / 1000000);

    // Calculate correct time based on offset from audio sent twice
    const correctedTime =
      resultEndTime - bridgingOffset + streamingLimit * restartCounter;

    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    let stdoutText = '';
    if (stream.results[0] && stream.results[0].alternatives[0]) {
      stdoutText = stream.results[0].alternatives[0].transcript;
    }

    if (stream.results[0].isFinal) {
      // TODO: Do all the changes below this
      process.stdout.write(chalk.green(`Transcribed text: ${stdoutText}\n`));
      process.stdout.write(chalk.green('################################\n'));
      socket.emit('message', { message: stdoutText });

      isFinalEndTime = resultEndTime;
      lastTranscriptWasFinal = true;
    } else {
      // Make sure transcript does not exceed console character length
      if (stdoutText.length > process.stdout.columns) {
        stdoutText =
          stdoutText.substring(0, process.stdout.columns - 4) + '...';
      }
      process.stdout.write(chalk.red(`${stdoutText}`));

      lastTranscriptWasFinal = false;
    }
  };

  const audioInputStreamTransform = new Transform({
    transform: (chunk, encoding, callback) => {
      if (newStream && lastAudioInput.length !== 0) {
        // Approximate math to calculate time of chunks
        const chunkTime = streamingLimit / lastAudioInput.length;
        if (chunkTime !== 0) {
          if (bridgingOffset < 0) {
            bridgingOffset = 0;
          }
          if (bridgingOffset > finalRequestEndTime) {
            bridgingOffset = finalRequestEndTime;
          }
          const chunksFromMS = Math.floor(
            (finalRequestEndTime - bridgingOffset) / chunkTime
          );
          bridgingOffset = Math.floor(
            (lastAudioInput.length - chunksFromMS) * chunkTime
          );

          for (let i = chunksFromMS; i < lastAudioInput.length; i++) {
            recognizeStream.write(lastAudioInput[i]);
          }
        }
        newStream = false;
      }

      audioInput.push(chunk);

      if (recognizeStream) {
        recognizeStream.write(chunk);
      }

      callback();
    },
  });

  function restartStream() {
    if (recognizeStream) {
      recognizeStream.removeListener('data', speechCallback);
      recognizeStream = null;
    }
    if (resultEndTime > 0) {
      finalRequestEndTime = isFinalEndTime;
    }
    resultEndTime = 0;

    lastAudioInput = [];
    lastAudioInput = audioInput;

    restartCounter++;

    if (!lastTranscriptWasFinal) {
      process.stdout.write(`\n`);
    }
    process.stdout.write(
      chalk.yellow(`${streamingLimit * restartCounter}: RESTARTING REQUEST\n`)
    );
    process.stdout.write(
      chalk.yellow(`-----------------------------------------------\n`)
    );

    newStream = true;

    startStream();
  }

  // Start recording and send the microphone input to the Speech API.
  recorder
    .record({
      sampleRateHertz: sampleRateHertz,
      threshold: 0, // Silence threshold
      silence: 1000,
      keepSilence: true,
      recordProgram: 'rec', // Try also "arecord" or "sox"
    })
    .stream()
    .on('error', (err) => {
      console.error('Audio recording error ' + err);
    })
    .pipe(audioInputStreamTransform);

  startStream();
}

require(`yargs`)
  .demandCommand(1)
  .command(
    `transcribe`,
    `infinitely stream audio input from microphone to speech API`,
    {},
    (opts) =>
      infiniteStream(
        opts.encoding,
        opts.sampleRateHertz,
        opts.languageCode,
        opts.streamingLimit
      )
  )
  .options({
    encoding: {
      alias: 'e',
      default: 'LINEAR16',
      global: true,
      requiresArg: true,
      type: 'string',
    },
    sampleRateHertz: {
      alias: 'r',
      default: 16000,
      global: true,
      requiresArg: true,
      type: 'number',
    },
    languageCode: {
      alias: 'l',
      default: 'en-US',
      global: true,
      requiresArg: true,
      type: 'string',
    },
    streamingLimit: {
      alias: 's',
      default: 10000,
      global: true,
      requiresArg: true,
      type: 'number',
    },
  })
  .example(`node $0 transcribe`)
  .wrap(120)
  .recommendCommands()
  .help()
  .strict().argv;

console.log(`Listening on ${port}, press Ctrl+C to stop.`);
