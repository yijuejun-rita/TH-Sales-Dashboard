"""Production data source: reads the private Google Sheet via a read-only
Service Account and returns {sheet_name: grid}, matching xlsx_source.py's
shape. Runs inside GitHub Actions where outbound internet access is
available (this repo's sandbox during development is network-restricted to
Google domains, so this path is exercised by the Actions workflow, not by
local test runs -- see etl/build_json.py's --source flag).

Auth: GOOGLE_SERVICE_ACCOUNT_JSON (the full key file content) is injected
as a GitHub Actions secret and read from the environment -- never written
to disk in the repo, never logged.
"""
import os
import json


SHEET_ID_ENV = 'GOOGLE_SHEET_ID'
CREDS_ENV = 'GOOGLE_SERVICE_ACCOUNT_JSON'
SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly']


def _get_service():
    from google.oauth2.service_account import Credentials
    from googleapiclient.discovery import build

    creds_raw = os.environ.get(CREDS_ENV)
    if not creds_raw:
        raise RuntimeError(f'{CREDS_ENV} is not set')
    info = json.loads(creds_raw)
    creds = Credentials.from_service_account_info(info, scopes=SCOPES)
    return build('sheets', 'v4', credentials=creds, cache_discovery=False)


def load_grids(sheet_id=None):
    sheet_id = sheet_id or os.environ.get(SHEET_ID_ENV)
    if not sheet_id:
        raise RuntimeError(f'{SHEET_ID_ENV} is not set')
    service = _get_service()
    meta = service.spreadsheets().get(spreadsheetId=sheet_id).execute()
    sheet_names = [s['properties']['title'] for s in meta['sheets']]

    grids = {}
    # Batch-fetch all sheets' full used range in one call to minimise quota use.
    ranges = [f"'{name}'" for name in sheet_names]
    resp = service.spreadsheets().values().batchGet(
        spreadsheetId=sheet_id, ranges=ranges, valueRenderOption='UNFORMATTED_VALUE',
    ).execute()
    for name, vr in zip(sheet_names, resp.get('valueRanges', [])):
        grids[name] = vr.get('values', [])
    return grids, sheet_names
