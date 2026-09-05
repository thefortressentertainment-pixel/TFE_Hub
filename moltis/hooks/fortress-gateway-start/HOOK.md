+++
name = "fortress-gateway-start"
description = "Ping the Fortress Hub Settlement when the gateway starts (read-only, best-effort)"
emoji = "🍄"
events = ["GatewayStart"]
command = "./handler.sh"
timeout = 15
+++

# Fortress Gateway Start

On `GatewayStart` (read-only, parallel dispatch), ping the Fortress Hub
(`http://127.0.0.1:4002`) health + Settlement ROI into a log. Never blocks or
modifies anything; if the hub is down the hook is a silent no-op.

Replaces the config-table `[hooks]` stanza, which this build does not register.