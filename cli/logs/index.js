'use strict';

const { startDashboard } = require('./dashboard');
const { startAndroidCollector, startIosSimulatorCollector, startIosDeviceCollector } = require('./collectors');
const { createSessionInfo, sampleMetrics, sampleProcessMatrix } = require('./telemetry');
const { NativeLogSession } = require('./session-store');

async function runLogs(args) {
  const dashboard = await startDashboard({ host: args.host, port: args.port, open: !args.noOpen });
  const sessionStore = new NativeLogSession();
  const publish = (event) => {
    const record = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, receivedAt: Date.now(), ...event };
    sessionStore.push(record);
    dashboard.publish(record);
  };
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

  let sessionCache = null;
  let sessionCacheAt = 0;
  const getSession = async () => {
    if (sessionCache && Date.now() - sessionCacheAt < 2000) return sessionCache;
    sessionCache = await createSessionInfo({
      collector,
      root: args.root,
      app: args.app,
      device: args.device,
      processName: args.process || collector.app || null
    });
    sessionCacheAt = Date.now();
    return sessionCache;
  };

  dashboard.setProcessProvider(() => typeof collector.listProcesses === 'function' ? collector.listProcesses() : []);
  dashboard.setSessionProvider(getSession);
  dashboard.setMetricsProvider((processName) => sampleMetrics({
    collector,
    device: args.device,
    processName: processName || args.process || collector.app || null
  }));
  dashboard.setProcessMetricsProvider(async () => {
    const session = await getSession();
    return sampleProcessMatrix({
      collector,
      device: args.device,
      mainProcess: session?.app?.primaryProcess || args.process || collector.app || null
    });
  });
  dashboard.setObservabilityProvider({
    async searchLogs(options) {
      const session = await getSession();
      return sessionStore.search(options, session?.app || {});
    },
    logContext(id, options) {
      return sessionStore.context(id, options);
    },
    async errorGroups(options) {
      const session = await getSession();
      return sessionStore.errorGroups(options, session?.app || {});
    },
    stats() {
      return sessionStore.stats();
    },
    clear() {
      sessionStore.clear();
    },
    async runtime(processName) {
      const session = await getSession();
      const target = processName || session?.app?.primaryProcess || args.process || collector.app || null;
      const nativeTelemetry = sessionStore.runtime(target);
      const hostMetrics = target ? sampleMetrics({
        collector,
        device: args.device,
        processName: target
      }) : { available: false, process: target };
      if (!nativeTelemetry) return hostMetrics;
      return {
        ...hostMetrics,
        ...nativeTelemetry,
        available: true,
        process: nativeTelemetry.process || hostMetrics.process || target,
        pid: nativeTelemetry.pid || hostMetrics.pid || null,
        memoryBytes: nativeTelemetry.residentMemoryBytes || hostMetrics.memoryBytes || null
      };
    }
  });

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
  return { collector, dashboard, sessionStore };
}

module.exports = { runLogs };
