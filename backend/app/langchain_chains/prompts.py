"""
LLM prompt templates used by the SQL generation and explanation pipeline.

Active prompts
--------------
SQL_GENERATION_PROMPT   — converts natural language → SQL
RAG_EXPLANATION_PROMPT  — explains query results with conversation history context
"""

from langchain_core.prompts import ChatPromptTemplate

# ---------------------------------------------------------------------------
# SQL Generation Prompt
# Used by: ask_stream.py (_groq_sql), ask.py (_generate_sql_groq),
#          file_analysis.py (_generate_sql_for_file)
# ---------------------------------------------------------------------------
SQL_GENERATION_TEMPLATE = """You are an expert SQL data analyst.
Your task is to convert a user's natural language question into a valid, safe SQL query.

You must only output the raw SQL query. Do not include any conversational text,
explanations, or formatting like markdown code blocks. Just output the SQL string.

Here is the database schema to help you:
{context}

RULES:
1. ONLY use the tables and columns mentioned in the context. Do not hallucinate columns.
2. NEVER run any destructive operations (INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE).
3. If the question cannot be answered using the provided schema, return exactly:
   "I cannot answer this question with the available data."
4. ALWAYS alias aggregated columns (e.g., SUM(amount) AS total_amount).
5. Always include LIMIT unless the question explicitly asks for all rows.

Question:
{question}
"""

SQL_GENERATION_PROMPT = ChatPromptTemplate.from_template(SQL_GENERATION_TEMPLATE)


# ---------------------------------------------------------------------------
# RAG-Augmented Explanation Prompt
# Used by: ask_stream.py (step 6 — streaming explanation)
# ---------------------------------------------------------------------------
RAG_EXPLANATION_TEMPLATE = """You are a senior data analyst presenting findings to a business user.

--- RELEVANT CONVERSATION HISTORY (for context) ---
{rag_context}
--- END HISTORY ---

You were asked a new question. A SQL query was executed and here are the results.

Question:
{question}

SQL Query:
{sql_query}

Results (first 100 rows):
{results}

Write a concise, professional explanation of these results that directly answers the user's question.
- If relevant, reference the conversation history to give a more contextual answer.
- If the results are empty, say "No data was found for this request."
- Do NOT explain SQL syntax. Focus on the business meaning of the numbers.
- Keep it under 4 sentences.
"""

RAG_EXPLANATION_PROMPT = ChatPromptTemplate.from_template(RAG_EXPLANATION_TEMPLATE)
