from fastapi import FastAPI, Query, Request, Response
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from typing import Dict, Any, List, Optional, Tuple
import requests, time, csv, io as iolib
import xml.etree.ElementTree as ET
from datetime import datetime

app = FastAPI(title="CBR", openapi_url="/openapi.json")

# Надёжный старт: не падать, если папки ещё нет
app.mount("/static", StaticFiles(directory="static", check_dir=False), name="static")
templates = Jinja2Templates(directory="templates")

CBR_DAILY_XML = "https://www.cbr.ru/scripts/XML_daily.asp"
CBR_DYNAMIC_XML = "https://www.cbr.ru/scripts/XML_dynamic.asp"

_cache: Dict[Tuple[str, Optional[str]], Tuple[float, Dict[str, Any]]] = {}
TTL_SECONDS = 60 * 15  # 15 минут

def _date_to_cbr(date_str: Optional[str]) -> Optional[str]:
    if not date_str:
        return None
    dt = datetime.strptime(date_str, "%Y-%m-%d").date()
    return dt.strftime("%d/%m/%Y")

def _ddmmyyyy_to_iso(ddmmyyyy: Optional[str]) -> Optional[str]:
    if not ddmmyyyy:
        return None
    try:
        d, m, y = ddmmyyyy.split(".")
        return f"{y}-{m}-{d}"
    except Exception:
        return None

def fetch_daily(date_iso: Optional[str] = None) -> Dict[str, Any]:
    key = ("daily", date_iso)
    now = time.time()
    if key in _cache:
        ts, data = _cache[key]
        if now - ts < TTL_SECONDS:
            return data

    params = {}
    cbr_date = _date_to_cbr(date_iso)
    if cbr_date:
        params["date_req"] = cbr_date

    try:
        r = requests.get(CBR_DAILY_XML, params=params, timeout=20)
    except Exception as e:
        return {"error": f"Network error: {e}"}

    if r.status_code != 200:
        return {"error": f"CBR returned {r.status_code}", "details": r.text[:300]}

    root = ET.fromstring(r.text)
    date_attr = root.attrib.get("Date")  # DD.MM.YYYY (фактическая дата ЦБ)

    items: List[Dict[str, Any]] = []
    rates: Dict[str, Dict[str, Any]] = {}

    for valute in root.findall("Valute"):
        charcode = valute.findtext("CharCode")
        name = valute.findtext("Name")
        nominal = int(valute.findtext("Nominal") or "1")
        value_text = (valute.findtext("Value") or "0").replace(",", ".")
        try:
            value = float(value_text)
        except:
            value = None
        numcode = valute.findtext("NumCode")
        vid = valute.attrib.get("ID")

        item = {
            "id": vid,
            "num_code": numcode,
            "char_code": charcode,
            "name": name,
            "nominal": nominal,
            "value": value,
        }
        items.append(item)

        if charcode and value is not None and nominal > 0:
            rates[charcode.upper()] = {
                "rub_per_unit": value / nominal,
                "nominal": nominal,
                "name": name,
                "id": vid,
            }

    # Добавляем RUB как 1:1
    rates["RUB"] = {"rub_per_unit": 1.0, "nominal": 1, "name": "Российский рубль", "id": "RUB"}

    data = {
        "date": date_attr,  # фактическая дата курсов ЦБ (DD.MM.YYYY)
        "count": len(items),
        "items": items,
        "rates_map": {k: {"rub_per_unit": v["rub_per_unit"], "name": v["name"], "id": v["id"]} for k, v in rates.items()},
    }
    _cache[key] = (now, data)
    return data

def get_valute_id(char_code: str, date_iso: Optional[str]=None) -> Optional[str]:
    data = fetch_daily(date_iso)
    if "error" in data:
        return None
    rm = data.get("rates_map") or {}
    info = rm.get(char_code.upper())
    return info.get("id") if info else None

def fetch_history(code: str, date_from: str, date_to: str) -> Dict[str, Any]:
    code = code.upper()
    if code == "RUB":
        # Плоская линия RUB=1
        try:
            dt_from = datetime.strptime(date_from, "%Y-%m-%d").date()
            dt_to = datetime.strptime(date_to, "%Y-%m-%d").date()
        except:
            return {"error": "bad dates"}
        if dt_to < dt_from:
            dt_from, dt_to = dt_to, dt_from
        delta = (dt_to - dt_from).days
        points = []
        for i in range(delta + 1):
            d = datetime.fromordinal(dt_from.toordinal() + i).date()
            points.append({"date": d.isoformat(), "rub_per_unit": 1.0})
        return {"code":"RUB","name":"Российский рубль","from":date_from,"to":date_to,"points":points}

    val_id = get_valute_id(code, None)
    if not val_id:
        return {"error": f"Не найден код {code}"}

    params = {
        "date_req1": _date_to_cbr(date_from),
        "date_req2": _date_to_cbr(date_to),
        "VAL_NM_RQ": val_id,
    }
    try:
        r = requests.get(CBR_DYNAMIC_XML, params=params, timeout=20)
    except Exception as e:
        return {"error": f"Network error: {e}"}
    if r.status_code != 200:
        return {"error": f"CBR returned {r.status_code}"}

    root = ET.fromstring(r.text)
    points: List[Dict[str, Any]] = []
    for rec in root.findall("Record"):
        date_attr = rec.attrib.get("Date")            # DD.MM.YYYY
        val_text = (rec.findtext("Value") or "0").replace(",", ".")
        nom_text = rec.findtext("Nominal") or "1"
        try:
            value = float(val_text)
            nominal = int(nom_text)
            per_unit = value / nominal if nominal else None
        except:
            per_unit = None
        try:
            dt = datetime.strptime(date_attr, "%d.%m.%Y").date()
            date_iso = dt.isoformat()
        except:
            date_iso = None
        if date_iso and per_unit is not None:
            points.append({"date": date_iso, "rub_per_unit": per_unit})

    data = fetch_daily(None)
    name = (data.get("rates_map") or {}).get(code, {}).get("name", code)
    return {"code": code, "name": name, "from": date_from, "to": date_to, "points": points}

# ===== API =====

@app.get("/cbr/daily")
def cbr_daily(
    date: Optional[str] = Query(None, description="YYYY-MM-DD — запрошенная дата"),
    strict: bool = Query(False, description="Если true — ошибка при несовпадении дат"),
):
    data = fetch_daily(date)
    if "error" in data:
        return data

    # добавим запрошенную дату
    out = {**data, "requested_date_iso": date}

    # строгая проверка совпадения дат (опционально)
    if strict and date:
        cbr_iso = _ddmmyyyy_to_iso(data.get("date"))
        if cbr_iso and cbr_iso != date:
            return {
                "error": f"Для {date} файл ЦБ недоступен (последняя дата ЦБ: {data.get('date')})."
            }
    return out

@app.get("/cbr/history")
def cbr_history(code: str = Query(...), date_from: str = Query(...), date_to: str = Query(...)):
    return fetch_history(code, date_from, date_to)

@app.get("/cbr/convert")
def cbr_convert(from_code: str, to_code: str, amount: float = 1.0, date: Optional[str] = None):
    data = fetch_daily(date)
    if "error" in data: return data
    rates_map = data.get("rates_map") or {}
    f, t = from_code.upper(), to_code.upper()
    if f not in rates_map: return {"error": f"Не найдена валюта {f} на {data.get('date')}"}
    if t not in rates_map: return {"error": f"Не найдена валюта {t} на {data.get('date')}"}
    rub_per_from = rates_map[f]["rub_per_unit"]
    rub_per_to = rates_map[t]["rub_per_unit"]
    rate = rub_per_from / rub_per_to if rub_per_to else None
    result = amount * rate if rate is not None else None
    return {"date": data.get("date"), "from": f, "to": t, "amount": amount, "rate": rate, "result": result}

@app.get("/cbr/daily.csv")
def cbr_daily_csv(date: Optional[str] = Query(None)):
    data = fetch_daily(date)
    if "error" in data: return data
    out = iolib.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(["char_code","name","nominal","rub_per_nominal","rub_per_1"])
    for it in data.get("items", []):
        per1 = (it["value"] / it["nominal"]) if it["value"] and it["nominal"] else None
        w.writerow([it["char_code"], it["name"], it["nominal"], it["value"], f"{per1:.6f}" if per1 else ""])
    csv_bytes = out.getvalue().encode("utf-8-sig")
    return Response(
        content=csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="cbr_daily_{(data.get("date") or "today").replace(".", "-")}.csv"'}
    )

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    data = fetch_daily(None)
    codes = sorted((data.get("rates_map") or {}).keys()) if isinstance(data, dict) else []
    if "RUB" not in codes: codes.append("RUB")
    return templates.TemplateResponse("index.html", {"request": request, "codes": codes})

if __name__ == "__main__":
    import os
    import uvicorn

    port = int(os.getenv("PORT", "8060"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")
