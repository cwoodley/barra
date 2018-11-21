#!/bin/bash
set -x

APP="barra"

systemctl start "${APP}" || :
