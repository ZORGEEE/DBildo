"""Локальный пример: загрузка orders из PostgreSQL в ClickHouse."""

import os

import clickhouse_connect
import psycopg2
from airflow.sdk import dag, task
from pendulum import datetime


@dag(
    dag_id="orders_to_clickhouse",
    start_date=datetime(2026, 9, 1, tz="UTC"),
    schedule=None,
    catchup=False,
    is_paused_upon_creation=False,
    tags=["dbildo", "demo"],
)
def orders_pipeline():
    @task
    def check_source():
        with psycopg2.connect(os.environ["DBILDO_SOURCE_PG_URL"]) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT COUNT(*) FROM public.orders")
                count = cursor.fetchone()[0]
        if count == 0:
            raise ValueError("Исходная таблица orders пуста")
        return count

    @task
    def load_orders(_count: int):
        with psycopg2.connect(os.environ["DBILDO_SOURCE_PG_URL"]) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT id, customer, amount, created_at FROM public.orders ORDER BY id")
                rows = cursor.fetchall()
        client = clickhouse_connect.get_client(
            host=os.environ["DBILDO_CLICKHOUSE_HOST"],
            username=os.environ["DBILDO_CLICKHOUSE_USER"],
            password=os.environ["DBILDO_CLICKHOUSE_PASSWORD"],
        )
        client.insert(
            "orders",
            rows,
            column_names=["id", "customer", "amount", "created_at"],
        )
        return len(rows)

    @task
    def verify_target(expected: int):
        client = clickhouse_connect.get_client(
            host=os.environ["DBILDO_CLICKHOUSE_HOST"],
            username=os.environ["DBILDO_CLICKHOUSE_USER"],
            password=os.environ["DBILDO_CLICKHOUSE_PASSWORD"],
        )
        actual = client.query("SELECT COUNT(*) FROM default.orders FINAL").first_row[0]
        if actual != expected:
            raise ValueError(f"Ожидали {expected} строк, получили {actual}")

    verify_target(load_orders(check_source()))


orders_pipeline()
