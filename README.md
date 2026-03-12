# Project Card Reader

App web para escanear tarjetas usando camara + OCR (Tesseract.js).

## Requisitos

- Node.js 20+
- Docker (opcional para contenedores)

## Ejecutar en local (sin Docker)

```bash
npm install
npm run dev
```

Abrir `http://localhost:5173` o desde otro equipo en la misma red: `http://TU_IP_LOCAL:5173`.

## Ejecutar con Docker Compose (simple)

1. Crear `.env` a partir de `.env.example`.
2. Configurar puerto host:

```env
APP_WEB_PORT=18080
```

3. Levantar stack:

```bash
docker compose up --build -d
```

4. Abrir:
- `http://TU_IP_LOCAL:18080`

## Portainer

1. Actualizar stack con este `docker-compose.yml`.
2. Definir variable `APP_WEB_PORT` (ejemplo `18080`).
3. Deploy.
4. Verificar en el contenedor `card-reader` que aparezca el publish `0.0.0.0:18080->80/tcp`.

## Cloudflare Tunnel (recomendado)

No necesitas Caddy dentro del stack para tener HTTPS publico.

Service del Tunnel:
- Type: `HTTP`
- URL: `http://card-reader:80` (si cloudflared esta en la misma red Docker)
- URL alternativa: `http://192.168.1.128:18080` (si cloudflared esta fuera de Docker)

Cloudflare termina HTTPS en el edge, y eso permite camara en movil usando tu dominio bajo Cloudflare.
