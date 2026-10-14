"""
LLM prompt templates used by the SQL generation and explanation pipeline.

Active prompts
--------------
SQL_GENERATION_PROMPT   — converts natural language → SQL (system message);
                          `{statement_rules}` is READ_ONLY_RULES for everyone,
                          ADMIN_WRITE_RULES when an admin may change data
RAG_EXPLANATION_PROMPT  — explains query results with conversation history context

These are plain str.format() templates. (They used to be LangChain
ChatPromptTemplates, whose .format() prefixes the text with "Human: ",
which leaked into the system prompt.)
"""

# ---------------------------------------------------------------------------
# SQL Generation Prompt
# Used by: services/query_pipeline.py (generate_sql)
# ---------------------------------------------------------------------------
SQL_GENERATION_PROMPT = """You are an expert SQL data analyst.
Your task is to convert a user's natural language question into a valid, safe SQL query.

TARGET DATABASE: {dialect_name}
Write the query using {dialect_name} syntax only (functions, date handling,
quoting and row-limiting must be valid for {dialect_name}).

You must only output the raw SQL query. Do not include any conversational text,
explanations, or formatting like markdown code blocks. Just output the SQL string.

Here is the database schema to help you:
{context}

RULES:
1. ONLY use the tables and columns mentioned in the context. Do not hallucinate columns.
{statement_rules}
4. Do not use SQL comments or semicolons.
5. If the question cannot be answered using the provided schema, return exactly:
   "I cannot answer this question with the available data."
6. ALWAYS alias aggregated columns (e.g., SUM(amount) AS total_amount).
7. Limit the number of returned rows unless the question explicitly asks for all rows.
8. Put the category/label column first and the numeric measure second when
   the result is a breakdown (this makes charts render correctly).
"""


READ_ONLY_RULES = """2. Output exactly ONE read-only SELECT statement (a WITH ... SELECT is fine).
3. NEVER use destructive operations (INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE)."""

# Admins: changes are shown to the admin and run only after they confirm them.
ADMIN_WRITE_RULES = """2. Output exactly ONE statement. Use a read-only SELECT (or WITH ... SELECT)
   for questions. ONLY when the user explicitly asks to add, change or remove
   data or tables, output ONE INSERT, UPDATE, DELETE, CREATE TABLE, ALTER TABLE
   or DROP TABLE statement instead.
3. UPDATE and DELETE must have a WHERE clause unless the user explicitly asks to
   change every row. Never touch databases, schemas, users or permissions.
4. INSERT / UPDATE values must satisfy each table's rules in the schema:
   - "checks": only use values the rule allows, spelled EXACTLY as in the rule
     (user says "completed", rule allows 'Completed' → write 'Completed').
   - Columns with a "default" (e.g. nextval(...) ids, CURRENT_TIMESTAMP) are
     filled by the database: leave them out unless the user gives a value.
   - Every non-nullable column without a default needs a value.
   - "foreign_keys": the value must be an id that exists in the referred table;
     if the user names it instead (e.g. an employee's name), look it up with a
     subquery: (SELECT employee_id FROM employees WHERE first_name = 'Diana')."""


# ---------------------------------------------------------------------------
# RAG-Augmented Explanation Prompt
# Used by: ask_stream.py (step 6 — streaming explanation)
# ---------------------------------------------------------------------------
RAG_EXPLANATION_PROMPT = """You are a senior data analyst presenting findings to a business user.

--- RELEVANT CONVERSATION HISTORY (for context) ---
{rag_context}
--- END HISTORY ---

You were asked a new question. A SQL query was executed and here are the results.

Question:
{question}

SQL Query:
{sql_query}

Results (first {preview_rows} of {total_rows} rows):
{results}

Write a concise, professional explanation of these results that directly answers the user's question.
- If relevant, reference the conversation history to give a more contextual answer.
- If the results are empty, say "No data was found for this request."
- Do NOT explain SQL syntax. Focus on the business meaning of the numbers.
- Keep it under 4 sentences.
"""
