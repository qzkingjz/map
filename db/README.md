# RAGFlow MySQL admin schema

This project reuses the MySQL service installed with RAGFlow, but keeps the
site admin system in a separate database named `qiaoqing_admin`.

## Current remote check

The RAGFlow web service at `http://117.50.226.240` is reachable, but TCP access
from this workstation to `117.50.226.240:3306` times out. The screenshot shows
that the MySQL container maps `0.0.0.0:3306->3306`, so the remaining blocker is
likely the cloud security group or host firewall.

## Execute on the RAGFlow server

Copy `db/init-ragflow-admin.sql` to the server and run it inside the MySQL
container:

```bash
sudo docker cp init-ragflow-admin.sql docker-mysql-1:/tmp/init-ragflow-admin.sql
sudo docker exec -it docker-mysql-1 mysql -uroot -p < /tmp/init-ragflow-admin.sql
```

If shell redirection is inconvenient, run:

```bash
sudo docker exec -it docker-mysql-1 bash
mysql -uroot -p < /tmp/init-ragflow-admin.sql
```

RAGFlow's default MySQL password is usually `infini_rag_flow`. If it was changed
for this deployment, use the value of `MYSQL_PASSWORD` from RAGFlow's Docker
`.env` file.

## Verify

```bash
sudo docker exec -it docker-mysql-1 mysql -uqiaoqing_app -pfjma1234 \
  -e "SHOW TABLES;" qiaoqing_admin
```

The expected tables are:

- `users`
- `auth_sessions`
- `audit_logs`
- `system_settings`
- `ragflow_connections`

## App connection

Use these values in this site's backend `.env` later:

```env
APP_DB_HOST=117.50.226.240
APP_DB_PORT=3306
APP_DB_NAME=qiaoqing_admin
APP_DB_USER=qiaoqing_app
APP_DB_PASSWORD=fjma1234
```

For production, prefer connecting from the app container through the same Docker
network as RAGFlow instead of opening MySQL to the public internet.
