# React dashboard

The dashboard source lives in `cli/dashboard/src` and is built with Vite. React is a development-time dependency for this repository only; consumers of `react-native-native-debugger` receive the prebuilt static dashboard and do not need to install React for the dashboard separately.

## Development

```bash
yarn install
yarn dashboard:dev
```

The Vite development server is useful for UI work. The CLI APIs remain:

- `/events` — Server-Sent Events native log stream
- `/processes` — running/observed process discovery
- `/health` — dashboard server health

## Production build

```bash
yarn dashboard:build
```

The output is written to `cli/dashboard/dist`. `cli/logs/dashboard.js` serves this directory when `rn-native-debugger logs` is used.

The high-frequency log ring buffer is intentionally kept outside React component state. React subscribes to a throttled log revision, while process/package/service/level facets have a separate revision that changes only when a new facet appears. This prevents open filter controls from being churned by every native log event.
