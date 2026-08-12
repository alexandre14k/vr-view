#!/bin/bash

if [ -t 0 ]; then
    python3 -B vr-view.py
else
    title="$BIN"
    xfce4-terminal\
        --title="$title"\
        -e "bash -c '$0 $@; exec bash'"
fi