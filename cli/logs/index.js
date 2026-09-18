'use strict';

const { startDashboard } = require('./dashboard');
const { startAndroidCollector, startIosSimulatorCollector, startIosDeviceCollector } = require('./collectors');
const { createSessionInfo, sampleMetrics } = require('./telemetry');

async function runLogs(args) {
  const dashboard = await startDashboard({ host: args.host, port: args.port, open: !args.noOpen });
  const publish = (event) => dashboard.publish({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, receivedAt: Date.now(), ...event });
  let collector;
  const common = {
    root: args.root,
    app: args.app,
    device: args.device,
    process: args.process,
    onEvent: publish,
    onDiagnostic: publish,
    onExit: (info) => publish({
      ...info,
      level: info.code === 0 ? 'info' : 'error',
      tag: 'collector',
      message: `collector exited (code=${info.code}, signal=${info.signal || 'none'})`
    })
  };

  if (args.platform === 'ios') collector = args.iosDevice ? startIosDeviceCollector(common) : startIosSimulatorCollector(common);
  else collector = startAndroidCollector(common);

  dashboard.setProcessProvider(() => typeof collector.listProcesses === 'function' ? collector.listProcesses() : []);
  dashboard.setSessionProvider(() => createSessionInfo({
    collector,
    root: args.root,
    app: args.app,
    device: args.device,
    processName: args.process || collector.app || null
  }));
  dashboard.setMetricsProvider((processName) => sampleMetrics({
    collector,
    device: args.device,
    processName: processName || args.process || collector.app || null
  }));

  console.log('React Native Native Debugger — native logs');
  console.log(`Dashboard: ${dashboard.url}`);
  console.log(`Collector: ${collector.command}`);
  if (collector.app) console.log(`App: ${collector.app}${collector.pid ? ` (pid ${collector.pid})` : ' (collector remains unfiltered unless --app was explicitly provided)'}`);
  console.log('Press Ctrl+C to stop.');

  const stop = async () => {
    collector.stop();
    await dashboard.close();
  };
  process.once('SIGINT', () => stop().finally(() => process.exit(0)));
  process.once('SIGTERM', () => stop().finally(() => process.exit(0)));
  return { collector, dashboard };
}

module.exports = { runLogs };
