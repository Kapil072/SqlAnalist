"""
Schema endpoint for frontend to display database structure.
"""
from fastapi import APIRouter
from app.db.schema_registry import get_schema
from app.db.connection import get_target_connection
from app.utils.logger import logger

router = APIRouter(tags=["schema"])


@router.get("/api/schema")
def get_database_schema():
    """
    Returns the database schema including tables, columns, and row counts.
    Also provides query suggestions for the frontend.
    """
    try:
        # Get the schema from registry
        schema_data = get_schema()
        
        # Enhance with row counts from actual database
        tables = []
        for table_name, table_info in schema_data.get("tables", {}).items():
            try:
                with get_target_connection() as conn:
                    cursor = conn.cursor()
                    # Use backticks for MySQL table names
                    cursor.execute(f"SELECT COUNT(*) FROM `{table_name}`")
                    row_count = cursor.fetchone()[0]
                    
                    tables.append({
                        "name": table_name,
                        "row_count": row_count,
                        "columns": table_info.get("columns", [])
                    })
            except Exception as e:
                logger.warning(f"Failed to get row count for {table_name}: {e}")
                # Still include the table even if row count fails
                tables.append({
                    "name": table_name,
                    "row_count": 0,
                    "columns": table_info.get("columns", [])
                })
        
        # Generate suggestions based on available tables
        suggestions = []
        table_names = [t["name"] for t in tables]
        
        if "customers" in table_names:
            suggestions.extend([
                "Show me the top 5 customers by spending",
                "How many customers do we have by country?",
                "What is the total revenue per customer?"
            ])
        
        if "orders" in table_names:
            suggestions.extend([
                "Show me recent orders",
                "What is the order status distribution?",
                "What is the average order value?"
            ])
        
        if "products" in table_names:
            suggestions.extend([
                "Show me top selling products",
                "What products are low in stock?",
                "Which categories generate the most revenue?"
            ])
        
        return {
            "tables": tables,
            "suggestions": suggestions
        }
        
    except Exception as e:
        logger.error(f"Failed to get schema: {e}")
        return {
            "tables": [],
            "suggestions": []
        }