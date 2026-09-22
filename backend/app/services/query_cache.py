"""
Query result caching service using Redis.
Caches query results for 5 minutes to improve performance for repeated queries.
"""
import hashlib
import json
import time
from typing import Any, Dict, List, Optional
import redis.asyncio as redis
from app.config import settings
from app.utils.logger import logger


class QueryCache:
    """Redis-based query result cache with TTL."""

    def __init__(self):
        self.redis_client: Optional[redis.Redis] = None
        self.cache_ttl = 300  # 5 minutes default TTL
        self.enabled = True

    async def initialize(self):
        """Initialize Redis connection."""
        try:
            # Try to connect to Redis (default localhost:6379)
            self.redis_client = await redis.from_url(
                "redis://localhost:6379",
                encoding="utf-8",
                decode_responses=True,
            )
            # Test connection
            await self.redis_client.ping()
            logger.info("[QUERY_CACHE] Redis connection established")
        except Exception as e:
            logger.warning(f"[QUERY_CACHE] Redis connection failed, caching disabled: {e}")
            self.redis_client = None
            self.enabled = False

    def _generate_cache_key(self, sql: str, data_source_id: Optional[str] = None) -> str:
        """Generate a unique cache key for a query."""
        # Create a hash of the SQL query
        sql_hash = hashlib.md5(sql.encode()).hexdigest()

        # Include data source ID if provided
        if data_source_id:
            return f"query:{data_source_id}:{sql_hash}"
        return f"query:default:{sql_hash}"

    async def get(self, sql: str, data_source_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Get cached query result if available."""
        if not self.enabled or not self.redis_client:
            return None

        try:
            cache_key = self._generate_cache_key(sql, data_source_id)
            cached_data = await self.redis_client.get(cache_key)

            if cached_data:
                logger.debug(f"[QUERY_CACHE] Cache hit for query: {sql[:50]}...")
                return json.loads(cached_data)

            logger.debug(f"[QUERY_CACHE] Cache miss for query: {sql[:50]}...")
            return None

        except Exception as e:
            logger.error(f"[QUERY_CACHE] Error retrieving from cache: {e}")
            return None

    async def set(
        self,
        sql: str,
        result: Dict[str, Any],
        data_source_id: Optional[str] = None,
        ttl: Optional[int] = None
    ) -> bool:
        """Cache query result with TTL."""
        if not self.enabled or not self.redis_client:
            return False

        try:
            cache_key = self._generate_cache_key(sql, data_source_id)
            cache_ttl = ttl or self.cache_ttl

            # Serialize the result
            cached_data = json.dumps(result)

            # Store in Redis with TTL
            await self.redis_client.setex(cache_key, cache_ttl, cached_data)
            logger.debug(f"[QUERY_CACHE] Cached query result for {cache_ttl}s: {sql[:50]}...")
            return True

        except Exception as e:
            logger.error(f"[QUERY_CACHE] Error caching result: {e}")
            return False

    async def invalidate(self, sql: str, data_source_id: Optional[str] = None) -> bool:
        """Invalidate a specific cached query."""
        if not self.enabled or not self.redis_client:
            return False

        try:
            cache_key = self._generate_cache_key(sql, data_source_id)
            await self.redis_client.delete(cache_key)
            logger.debug(f"[QUERY_CACHE] Invalidated cache for query: {sql[:50]}...")
            return True

        except Exception as e:
            logger.error(f"[QUERY_CACHE] Error invalidating cache: {e}")
            return False

    async def invalidate_data_source(self, data_source_id: str) -> bool:
        """Invalidate all cached queries for a specific data source."""
        if not self.enabled or not self.redis_client:
            return False

        try:
            pattern = f"query:{data_source_id}:*"
            keys = await self.redis_client.keys(pattern)

            if keys:
                await self.redis_client.delete(*keys)
                logger.info(f"[QUERY_CACHE] Invalidated {len(keys)} cached queries for data source {data_source_id}")
                return True

            return False

        except Exception as e:
            logger.error(f"[QUERY_CACHE] Error invalidating data source cache: {e}")
            return False

    async def clear_all(self) -> bool:
        """Clear all cached query results."""
        if not self.enabled or not self.redis_client:
            return False

        try:
            pattern = "query:*"
            keys = await self.redis_client.keys(pattern)

            if keys:
                await self.redis_client.delete(*keys)
                logger.info(f"[QUERY_CACHE] Cleared {len(keys)} cached queries")
                return True

            return False

        except Exception as e:
            logger.error(f"[QUERY_CACHE] Error clearing cache: {e}")
            return False

    async def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        if not self.enabled or not self.redis_client:
            return {
                "enabled": False,
                "cached_queries": 0,
            }

        try:
            pattern = "query:*"
            keys = await self.redis_client.keys(pattern)

            return {
                "enabled": True,
                "cached_queries": len(keys),
                "ttl_seconds": self.cache_ttl,
            }

        except Exception as e:
            logger.error(f"[QUERY_CACHE] Error getting stats: {e}")
            return {
                "enabled": False,
                "error": str(e),
            }


# Global cache instance
query_cache = QueryCache()