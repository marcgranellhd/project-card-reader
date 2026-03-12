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
APP_DOMAIN=cards.tudominio.com
LETSENCRYPT_EMAIL=tu-correo@tudominio.com
```

3. Asegurar DNS y red:
- `APP_DOMAIN` debe apuntar al servidor Docker/Portainer.
- Puertos `80` y `443` abiertos hacia ese servidor.

4. Levantar stack:

```bash
docker compose up --build -d
```

5. Abrir `https://cards.tudominio.com`.

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
4. Verificar que el host de Portainer reciba trafico en `80/443`.
5. Deploy stack.
6. Entrar por `https://APP_DOMAIN`.

Importante para camara en movil:

- La camara solo funciona en contexto seguro: `https://` o `localhost`.
- En movil, usa certificado valido (Let’s Encrypt). Un certificado no confiable puede bloquear permisos de camara.
- Si solo usas IP local (`http://192.168.x.x`) el navegador movil bloqueara `getUserMedia`.
