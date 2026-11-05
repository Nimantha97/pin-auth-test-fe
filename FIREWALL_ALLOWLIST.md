# EVINA / DCBprotect — Firewall Allowlist Request

## Problem summary

The EVINA anti-fraud kit works in our **local** environment but is **blocked on the
on-prem deployment**. After the user clicks **Subscribe/Request PIN**, the EVINA kit
(injected into the page) tries to reach several EVINA domains. Those calls succeed
locally but are dropped on-prem — the firewall is blocking the outbound traffic.

## The key point for DevOps (read this first)

These are **NOT server-to-server calls** from our backend. They are made by the
**end user's browser** directly to EVINA's servers.

Evidence — every blocked request carries browser headers:

```
origin:   http://localhost:4000      <- our page (the browser's current site)
referer:  http://localhost:4000/
sec-fetch-site: cross-site           <- browser going to a different site (EVINA)
user-agent: Mozilla/5.0 ... Chrome/155...
```

So the traffic flow is:

```
End-user browser  ──(outbound / egress)──►  EVINA servers
```

This means:

- **SOURCE** = the machine/network where the **browser** runs
  (our internal test machines today; in production, wherever end users browse from).
- **DESTINATION** = EVINA's domains listed below.
- The rule needed is **OUTBOUND (egress)**, from the client network to EVINA — not
  an inbound or server-to-server rule.

> If real production end users browse from the **public internet** (mobile data /
> home wifi), our on-prem firewall never sees their traffic, so only our **internal
> test machines** need this egress rule. The block we are hitting now is because our
> test browsers sit behind the corporate firewall.

## Allowlist to open (OUTBOUND / egress)

| Destination (host)                 | Port  | Protocol                | Purpose                         |
|------------------------------------|-------|-------------------------|---------------------------------|
| `notify.eyewitness.evina.com`      | 443   | HTTPS (TCP)             | Kit telemetry / notify          |
| `notify.dcbprotect.com`            | 443   | HTTPS (TCP)             | Kit event reporting (load, etc.)|
| `ws.dcbprotect.com`                | 8080  | WebSocket Secure (wss)  | Real-time metrics channel       |

Recommended (safer, covers subdomain/endpoint rotation by EVINA):

- Allow `*.evina.com` and `*.dcbprotect.com` on **TCP 443**
- Allow `*.dcbprotect.com` on **TCP 8080** for the WebSocket

## Two things to flag explicitly to DevOps

1. **`wss://ws.dcbprotect.com:8080` is the most likely culprit.**
   - Many firewalls allow 443 but block non-standard ports such as **8080**.
   - Many proxies also block the WebSocket `Upgrade` handshake.
   - Please open **TCP 8080** to that host **and** allow WebSocket upgrades.

2. **If an intercepting / TLS-inspecting proxy is in the path**, it must:
   - Allow these hostnames (SNI-based allowlisting is cleanest), and
   - Not strip the WebSocket `Upgrade` header.

## How to confirm which destinations are blocked

Run these from a machine **on the on-prem network** (same egress path as the testers):

```powershell
# HTTPS endpoints
curl -v https://notify.eyewitness.evina.com/ --max-time 10
curl -v https://notify.dcbprotect.com/ --max-time 10

# WebSocket port reachability (the usual culprit)
Test-NetConnection ws.dcbprotect.com -Port 8080
```

If `Test-NetConnection ... -Port 8080` returns `TcpTestSucceeded : False`, the
WebSocket port is firewalled — hand that result to DevOps.


## Note / follow-up with EVINA

The three hosts above are the ones **our** traffic actually used in this session, so
they are accurate for our account. EVINA may use **additional** hosts in production
(script delivery, regional endpoints) that did not fire in this particular test.
Request EVINA's **official firewall allowlist (domains + IP ranges + ports)** and give
it to DevOps alongside this document to cover everything.
