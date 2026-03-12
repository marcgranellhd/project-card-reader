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

Build de produccion:

```bash
npm run build
npm run preview
```

## Ejecutar con Docker Compose (HTTPS)

Este stack incluye Caddy para HTTPS automatico.

1. Crear `.env` a partir de `.env.example`.
2. Configurar variables:

```env
APP_DOMAIN=reader.marcgrabel.cc
LETSENCRYPT_EMAIL=tu-correo@tudominio.com
APP_HTTP_PORT=8088
APP_HTTPS_PORT=8443
```

3. Asegurar DNS y red:
- `APP_DOMAIN` debe apuntar al servidor Docker/Portainer.
- Si usas puertos alternos, abrir `APP_HTTP_PORT` y `APP_HTTPS_PORT`.

4. Levantar stack:

```bash
docker compose up --build -d
```

5. Abrir `https://reader.marcgrabel.cc:8443`.

## Modo desarrollo en contenedor

```bash
docker compose -f docker-compose.dev.yml up
```

Abrir `http://localhost:5173`.
Desde la red local: `http://TU_IP_LOCAL:5173`.

## Despliegue en Portainer

1. Crear un Stack nuevo.
2. Usar el contenido de `docker-compose.yml` o apuntar Portainer a este repo.
3. Definir variables de entorno del stack:
- `APP_DOMAIN`
- `LETSENCRYPT_EMAIL`
- `APP_HTTP_PORT`
- `APP_HTTPS_PORT`
4. Verificar que el host de Portainer reciba trafico en esos puertos.
5. Deploy stack.
6. Entrar por `https://APP_DOMAIN:APP_HTTPS_PORT`.

Nota Portainer:

- Este compose ya no usa bind mount de `./Caddyfile`, para evitar errores tipo `read-only file system` en `/data/compose/...`.

Importante para camara en movil:

- La camara solo funciona en contexto seguro: `https://` o `localhost`.
- En movil, usa certificado valido (Let’s Encrypt). Un certificado no confiable puede bloquear permisos de camara.
- Si solo usas IP local (`http://192.168.x.x`) el navegador movil bloqueara `getUserMedia`.
- Para emitir certificado publico con Let’s Encrypt, el dominio debe resolver al servidor y permitir validacion ACME.

