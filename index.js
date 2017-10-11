/*globals document, pryv, _, Plotly*/
var container = document.getElementById('pryvGraphs');
var monitor;

/**
 * retrieve the registerURL from URL parameters
 */
function getRegisterURL() {
  return pryv.utility.urls.parseClientURL().parseQuery()['reg-pryv'] || pryv.utility.urls.parseClientURL().parseQuery()['pryv-reg'];
}

var customRegisterUrl = getRegisterURL();
if (customRegisterUrl) {
  pryv.Auth.config.registerURL = {host: customRegisterUrl, 'ssl': true};
}

/**
 * retrieve the registerURL from URL parameters
 */
function getSettingsFromURL() {
  var settings = {
    username : pryv.utility.urls.parseClientURL().parseQuery().username,
    domain : pryv.utility.urls.parseClientURL().parseQuery().domain,
    auth: pryv.utility.urls.parseClientURL().parseQuery().auth
  };

  if (settings.username && settings.auth) {
    return settings;
  }

  return null;
}

function setupShareLink(connect) {
  var urlLabel = document.getElementById('sharelink');
  urlLabel.innerHTML = ('' + document.location).split('?')[0] +
    '?username=' + connect.username +
    '&domain=' + connect.domain +
    '&auth=' + connect.auth;
}

document.onreadystatechange = function () {

  document.getElementById('loading').style.display = 'none';
  document.getElementById('logo-pryv').style.display = 'block';
  var state = document.readyState;
  if (state == 'complete') {
    var settings = getSettingsFromURL();
    if (settings) {
      var connection = new pryv.Connection(settings);
      connection.fetchStructure(function (err, streams) {
        initVoltammetry(connection, streams);
        setupMonitor(connection);
      });
    } else {

      // Authenticate user
      var authSettings = {
        requestingAppId: 'appweb-plotly',
        requestedPermissions: [
          {
            streamId: '*',
            level: 'read'
          }
        ],
        returnURL: false,
        spanButtonID: 'pryv-button',
        callbacks: {
          needSignin: resetPlots,
          needValidation: null,
          signedIn: function (connect) {
            connect.fetchStructure(function (connection, streams) {
              initVoltammetry(connect, streams);
              setupMonitor(connect);
            });
          }
        }
      };
      pryv.Auth.setup(authSettings);
    }
  }
};

// MONITORING
// Setup monitoring for remote changes
function setupMonitor(connection) {
  setupShareLink(connection);

  document.getElementById('loading').style.display = 'block';
  document.getElementById('logo-pryv').style.display = 'none';
  var filter = new pryv.Filter({limit: 10000});
  monitor = connection.monitor(filter);

  // should be false by default, will be updated in next lib version
  // to use fullCache call connection.ensureStructureFetched before
  monitor.ensureFullCache = false;
  monitor.initWithPrefetch = 0; // default = 100;

  // get presets from stream structure
  connection.streams.walkTree({}, function (stream) { 
    if (stream.clientData && stream.clientData['app-web-plotly']) {
      Object.keys(stream.clientData['app-web-plotly']).forEach(function(eventType) {
        var traceKey = stream.id + '_' + eventType;
        presets[traceKey] = stream.clientData['app-web-plotly'][eventType];
      });
    }
    console.log('Stream:' + stream.id + '->' + JSON.stringify(stream.clientData));
  });


  // get notified when monitoring starts
  monitor.addEventListener(pryv.MESSAGES.MONITOR.ON_LOAD, function (events) {

    document.getElementById('loading').style.display = 'none';
    document.getElementById('logo-pryv').style.display = 'block';
    updatePlot(events);

  });

  // get notified when data changes
  monitor.addEventListener(pryv.MESSAGES.MONITOR.ON_EVENT_CHANGE, function (changes) {
    updatePlot(changes.created);
  });

  // start monitoring
  monitor.start(function (/**err**/) {
  });
}

// Traces
var traces = {};
var presets = {};
var plots = {};

function getDateString(timestamp) {
  var date = new Date(timestamp);
  return date.toISOString().substring(0, 10) + ' '  +
    date.toISOString().substring(11, 19) + '.' + date.getMilliseconds();
}

function createTrace(event) {
  var traceKey = event.streamId + '_' + event.type;
  var extraType = pryv.eventTypes.extras(event.type);
  var titleY = extraType.symbol ? extraType.symbol : event.type;

  if(presets[traceKey] && presets[traceKey].titleY) {
    titleY = presets[traceKey].titleY;
  }

  traces[traceKey] = {
    plotKey: traceKey,
    type: event.type,
    streamId: event.streamId + ' ' + titleY,
    last: event.timeLT,
    gaps: null,
    trace: {},
    yaxis : {
      yaxis1: {
        title : titleY,
        showticklabels : true,
        side: 'right'
      }
    }
  };

  if (presets[traceKey]) {
    _.extend(traces[traceKey], presets[traceKey]);
  }

  traces[traceKey].trace.x = [];
  traces[traceKey].trace.y = [];

  if (! plots[traces[traceKey].plotKey]) {
    var title = '';

    if (presets[traceKey] && presets[traceKey].plotKey) {
      // name per plotKey
      title = presets[traceKey].plotKey;
    } else { // take stream path
      event.stream.ancestors.forEach(function (ancestor) {
        title += ancestor.name + '/';
      });
      title += event.stream.name;
    }
    plots[traces[traceKey].plotKey] = {
      layout : { title : title }
    };
  }

  plots[traces[traceKey].plotKey].layout.xaxis = {
    rangeselector: selectorOptions,
    title: 'Time',
    type: 'date',
    showticklabels : true
  };

  if (! plots[traces[traceKey].plotKey].num) { // first plot
    plots[traces[traceKey].plotKey].num = 1;
    traces[traceKey].layout = {
      yaxis1: {
        title : titleY,
        showticklabels : true,
        side: 'left'
      }
    };

  } else {
    var num = ++plots[traces[traceKey].plotKey].num;
    var pos = 1 - + ((num-2) * 0.05);
    traces[traceKey].layout = {};
    traces[traceKey].layout['yaxis' + num] = {
      title : titleY,
      showticklabels : true,
      side: 'right',
      overlaying: 'y',
      position: pos
    };
    traces[traceKey].trace.yaxis = 'y' + num;
  }
}

var initializedTraces = {};
var initializedPlots = {};

var lastLastX = 0;
var gap = 1 * 30 * 1000;

function initOrRedraw(traceKey) {

  var trace = traces[traceKey];
  if (initializedTraces[traceKey]) {
    if (liveRange && (lastX  > (lastLastX + gap))) {
      var start = lastX - liveRange * 60 * 1000;
      var stop = lastX + 1 * 30 * 1000;
      lastLastX = lastX;
      setAllRanges(getDateString(start), getDateString(stop));
      previousWasLiverange = true;
    }

    return Plotly.redraw(trace.plotKey);
  }
  initializedTraces[traceKey] = true;

  if (! initializedPlots[trace.plotKey]) {
    initializedPlots[trace.plotKey] = true;
    var plot = document.createElement('div');
    plot.setAttribute('id', trace.plotKey);
    container.appendChild(plot);

    Plotly.newPlot(trace.plotKey, [], plots[trace.plotKey].layout);
  }

  Plotly.relayout(trace.plotKey, trace.layout);
  Plotly.addTraces(trace.plotKey, [trace.trace]);
}


/**
 * retrieve the registerURL from URL parameters
 */
function getLiveRangeURL() {
  return pryv.utility.urls.parseClientURL().parseQuery()['liverange'];
}


var lastX = 0;
var liveRange = getLiveRangeURL() || 0;



var ignoreFrom = 0; // ((new Date().getTime())) - (60 * 60 * 24 * 1000 * 10);

function updatePlot(events) {
  // Needed ?
  events = events.sort(function (a, b) {
    return a.time - b.time;
  });

  var toRedraw = {};

  events.map(function (event) {
    var traceKey = event.streamId + '_' + event.type;

    if (! pryv.eventTypes.isNumerical(event)) {
      traces[traceKey] = { ignore : true};
      return;
    }

    if (event.trashed || (ignoreFrom > event.timeLT)) {
    return;
    }

    if (! traces[traceKey]) {
      createTrace(event);
    }

    if (! traces[traceKey].ignore) {
      if (traces[traceKey].gaps) {
        if ((event.timeLT - traces[traceKey].last) > traces[traceKey].gaps * 1000) {
          traces[traceKey].trace.x.push(getDateString(traces[traceKey].last + 1));
          traces[traceKey].trace.y.push(null);
        }
      }

      if (event.timeLT > lastX) {
        lastX = event.timeLT;
      }

      traces[traceKey].trace.x.push(getDateString(event.timeLT));
      traces[traceKey].trace.y.push(event.content);
      traces[traceKey].last = event.timeLT;

      toRedraw[traceKey] = true;
    }

  });

  Object.keys(toRedraw).forEach(function (traceKey) {
    initOrRedraw(traceKey);
  });
}

function setAllForRealTime () {
  var now = new Date().getTime();
  var start = now - 5 * 60 * 1000;
  var stop = now + 5 * 60 * 1000;
  setAllRanges(getDateString(start), getDateString(stop));
}

function setAllRanges(start, stop) {
  Object.keys(plots).forEach(function (plotKey) {
    Plotly.relayout(plotKey, {xaxis: {range : [start, stop]}});
  });
}


function resetPlots() {
  document.getElementById('sharelink').innerHTML = null;
  container.innerHTML = null;
  if (monitor) {
    monitor.destroy();
  }
}


// *** Plotly designs ***  //
var selectorOptions = {
  buttons: [
    {
      step: 'hour',
      stepmode: 'backward',
      count: 1,
      label: '1h'
    }, {
      step: 'day',
      stepmode: 'backward',
      count: 1,
      label: '1d'
    }, {
    step: 'month',
      stepmode: 'backward',
      count: 1,
      label: '1m'
     }, {
    step: 'month',
    stepmode: 'backward',
    count: 6,
    label: '6m'
  }, {
    step: 'year',
    stepmode: 'backward',
    count: 1,
    label: '1y'
  }, {
    step: 'all'
  }]
};

function initVoltammetry(connection, streams) {
  streams.forEach(function (stream) {
    if(stream.id.includes('voltammetry')) {
      var contain = document.createElement('div');
      var plot = document.createElement('div');
      plot.setAttribute('id', stream.id);
      contain.appendChild(plot);
      var currentDate = new Date();
      currentDate.setHours(0);
      currentDate.setMinutes(0);
      currentDate.setSeconds(0);
      var currentTime = currentDate.getTime() / 1000;
      var currentDay = currentDate.getDay();
      var days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

      plotVoltammetry(connection, stream.id, currentTime, days[currentDay]);
      
      for(i=6; i>=0; i--) {
        var button = document.createElement('button');
        var dayOfInterest = currentTime-(60*60*24*(i-2));
        var dayString = days[(currentDay-i+7)%7]
        button.innerHTML = dayString;
        button.setAttribute('day', dayOfInterest);
        button.setAttribute('dayString', dayString);
        button.onclick = function () {
          plotVoltammetry(connection, stream.id, this.getAttribute('day'), this.getAttribute('dayString'));
        };
        contain.appendChild(button);
      }
      container.appendChild(contain);
    }
  });
}

function plotVoltammetry(connection, id, time, day) {
  var filter = new pryv.Filter({streams : [id], toTime: time});
  connection.events.get(filter, function (err, events) {
    if(err || events==null) return;
    var voltage = [];
    var current = [];
    events.forEach(function(event) {
      var jsonContent = JSON.parse(event.content);
      voltage.push(jsonContent.voltage);
      current.push(jsonContent.current);
    });
    
    var trace = {
      x: voltage,
      y: current,
      mode: "lines",
      name: id,
      connectgaps: true,
      xaxis: "x1",
      yaxis: "y1"
    };
    var layout = {
      title: id  + " - " + day,
      xaxis1: {
          anchor: "y1",
          domain: [0.0, 1.0],
          title: "Voltage (mV)"
      },
      yaxis1: {
          anchor: "x1",
          domain: [0.0, 1.0],
          title: "Current (uA)"
      }
    };
    Plotly.newPlot(id, [trace], layout);
  });
}