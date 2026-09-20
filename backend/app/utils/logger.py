# Simple logger setup using standard library

import logging


def setup_logger(name: str = "sqlanalyst") -> logging.Logger:
    """Create and configure a basic logger.

    The logger prints to stderr with a concise format and captures
    INFO level and above. It can be imported and used directly:
    `logger = setup_logger()`.
    """
    logger = logging.getLogger(name)
    if not logger.handlers:
        logger.setLevel(logging.INFO)
        handler = logging.StreamHandler()
        formatter = logging.Formatter(
            "%(asctime)s - %(levelname)s - %(name)s - %(message)s",
            "%Y-%m-%d %H:%M:%S",
        )
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    return logger

# Export a default logger instance for convenience
logger = setup_logger()
