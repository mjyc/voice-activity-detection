"use strict";
var analyserFrequency = require("analyser-frequency-average");

module.exports = function(audioContext, stream, opts) {
  opts = opts || {};

  var defaults = {
    fftSize: 1024,
    bufferLen: 1024,
    smoothingTimeConstant: 0.2,
    minCaptureFreq: 85, // in Hz
    maxCaptureFreq: 255, // in Hz
    useNoiseCapture: true,
    noiseCaptureDuration: 1000, // in ms
    minNoiseLevel: 0.3, // from 0 to 1
    maxNoiseLevel: 0.7, // from 0 to 1
    avgNoiseMultiplier: 1.2,
    activityCounterMin: 0,
    activityCounterMax: 60,
    activityCounterThresh: 5,
    useDefaultActivityCounting: true,
    onInit: function(baseLevel) {},
    onVoiceStart: function() {},
    onVoiceStop: function() {},
    onUpdate: function(val) {},
    logger: {
      debug: function() {}
    }
  };

  var options = {};
  for (var key in defaults) {
    options[key] = opts.hasOwnProperty(key) ? opts[key] : defaults[key];
  }

  var logger = options.logger;
  var prevStamp = Date.now();

  var baseLevel = 0;
  var voiceScale = 1;
  var useNoiseCapture = options.useNoiseCapture;
  var activityCounter = 0;
  var activityCounterMin = options.activityCounterMin;
  var activityCounterMax = options.activityCounterMax;
  var activityCounterThresh = options.activityCounterThresh;
  var useDefaultActivityCounting = options.useDefaultActivityCounting;

  var envFreqRange = [];
  var isNoiseCapturing = useNoiseCapture;
  var prevVadState = undefined;
  var vadState = false;
  var captureTimeout = null;

  var source = audioContext.createMediaStreamSource(stream);
  var analyser = audioContext.createAnalyser();
  analyser.smoothingTimeConstant = options.smoothingTimeConstant;
  analyser.fftSize = options.fftSize;

  var scriptProcessorNode = audioContext.createScriptProcessor(
    options.bufferLen,
    1,
    1
  );
  connect();
  scriptProcessorNode.onaudioprocess = monitor;

  if (isNoiseCapturing) {
    captureTimeout = setTimeout(init, options.noiseCaptureDuration);
  } else {
    // run "simplified init"
    baseLevel = options.minNoiseLevel; // assuming mic does noise canceling
    voiceScale = 1 - baseLevel;

    logger.debug("baseLevel", baseLevel);
    options.onInit(baseLevel);
  }

  function init() {
    isNoiseCapturing = false;

    envFreqRange = envFreqRange
      .filter(function(val) {
        return val;
      })
      .sort();
    var averageEnvFreq = envFreqRange.length
      ? envFreqRange.reduce(function(p, c) {
          return Math.min(p, c);
        }, 1)
      : options.minNoiseLevel || 0.1;

    baseLevel = averageEnvFreq * options.avgNoiseMultiplier;
    if (options.minNoiseLevel && baseLevel < options.minNoiseLevel)
      baseLevel = options.minNoiseLevel;
    if (options.maxNoiseLevel && baseLevel > options.maxNoiseLevel)
      baseLevel = options.maxNoiseLevel;

    voiceScale = 1 - baseLevel;

    logger.debug("baseLevel", baseLevel);
    options.onInit(baseLevel);
  }

  function connect() {
    source.connect(analyser);
    analyser.connect(scriptProcessorNode);
    scriptProcessorNode.connect(audioContext.destination);
  }

  function disconnect() {
    scriptProcessorNode.disconnect();
    analyser.disconnect();
    source.disconnect();
  }

  function destroy() {
    captureTimeout && clearTimeout(captureTimeout);
    disconnect();
    scriptProcessorNode.onaudioprocess = null;
  }

  function monitor() {
    var frequencies = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(frequencies);

    var average = analyserFrequency(
      analyser,
      frequencies,
      options.minCaptureFreq,
      options.maxCaptureFreq
    );
    if (isNoiseCapturing) {
      envFreqRange.push(average);
      return;
    }

    if (average >= baseLevel && activityCounter < activityCounterMax) {
      activityCounter++;
      if (
        !useDefaultActivityCounting &&
        activityCounter > activityCounterThresh
      )
        activityCounter = activityCounterMax;
    } else if (average < baseLevel && activityCounter > activityCounterMin) {
      activityCounter--;
      if (
        !useDefaultActivityCounting &&
        activityCounter < activityCounterThresh
      )
        activityCounter = activityCounterMin;
    }
    vadState = activityCounter > activityCounterThresh;

    if (prevVadState !== vadState) {
      vadState ? onVoiceStart() : onVoiceStop();
      prevVadState = vadState;
    }

    var stamp = Date.now();
    logger.debug(
      "hz",
      1000 / (prevStamp - stamp),
      "average",
      average,
      "activityCounter",
      activityCounter
    );
    prevStamp = stamp;

    options.onUpdate(Math.max(0, average - baseLevel) / voiceScale);
  }

  function onVoiceStart() {
    options.onVoiceStart();
  }

  function onVoiceStop() {
    options.onVoiceStop();
  }

  return { connect: connect, disconnect: disconnect, destroy: destroy };
};
