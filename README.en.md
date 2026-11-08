<div align="center">

<img src="resources/icons/icon.png" width="96" alt="Orbita" />

# Orbita

**A Windows desktop proxy & VPN client powered by sing-box**

Subscriptions, share links, SOCKS/HTTP proxies, TUN mode for all traffic, live stats and logs — in one clean window.

[Русский](README.md)

</div>

![Home](docs/home.png)

## Features

- **Protocols:** VLESS (incl. Reality and Vision), VMess, Trojan, Shadowsocks (incl. 2022), Hysteria 2 and Hysteria, TUIC, AnyTLS, SOCKS4/4a/5, HTTP and HTTPS.
- **Subscriptions:** base64, plain link lists, Clash YAML, sing-box JSON. Quota and expiry from headers, auto-update, format negotiation by User-Agent.
- **Three connection modes:** system proxy, TUN (virtual adapter for every app, games and UDP), local port only (`127.0.0.1:2088`, SOCKS5 + HTTP).
- **Routing:** rule-based, global or direct. Russian sites and IPs go direct, ad blocking, custom rules by domain, IP, process, geosite and geoip.
- **Admin rights once.** Windows asks on first launch; after that Orbita starts elevated via Task Scheduler with no UAC prompt, so TUN is always available.
- **Dashboard:** big connect button, live speed chart, session and daily traffic, exit IP with country flag.
- **Servers:** groups, search, sorting, bulk latency test (works while disconnected), seamless in-group switching, share links, JSON editing.
- **Connections** table, core **logs** with level filter and search, daily and per-server **statistics**.
- **One-click import from NekoBox/NekoRay.**
- Tray menu, autostart, dark and light themes, accent colors.

## Build

```bash
npm install
npm run dev
npm test
npm run dist   # installer and portable exe in release/
```

## Limitations

- The Xray **xhttp** transport is not supported by sing-box; such servers are skipped.
- WireGuard links are not accepted yet (in sing-box 1.14 WireGuard is an endpoint).
- Windows only.

## License

MIT © dimon0804. The bundled [sing-box](https://github.com/SagerNet/sing-box) core is GPL-3.0.
