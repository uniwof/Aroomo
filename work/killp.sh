#!/bin/bash
for p in "$@"; do pkill -f "\-\-port $p"; done; pkill -f workerd; sleep 2
