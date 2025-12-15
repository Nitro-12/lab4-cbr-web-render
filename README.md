# CBR FastAPI Web (Lab 4)

Небольшой веб-сервис на FastAPI с HTML-страницей и API для получения курсов ЦБ РФ.

## Локальный запуск
```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```
Открыть: http://127.0.0.1:8000

## Деплой на Render
### Вариант 1 (через панель)
- Build Command: `pip install -r requirements.txt`
- Start Command: `uvicorn main:app --host 0.0.0.0 --port $PORT`

### Вариант 2 (Blueprint)
Файл `render.yaml` уже лежит в корне репозитория.
