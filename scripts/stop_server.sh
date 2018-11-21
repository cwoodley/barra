#!/bin/bash
set -x

APP="barra"

systemctl stop "${APP}" || :
