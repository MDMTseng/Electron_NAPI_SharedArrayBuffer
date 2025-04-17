def process_data(args):
    """
    Test function that processes incoming data
    Args:
        args: List of string arguments
    Returns:
        str: Processed result
    """
    if not args:
        return "Error: No data provided"
    
    # Simple processing: convert to uppercase and add some metadata
    processed = [arg.upper() for arg in args]
    result = {
        "original": args,
        "processed": processed,
        "length": len(args),
        "timestamp": "2024-04-17"  # Example metadata
    }
    
    return str(result)

def test_function(args):
    """
    Another test function
    Args:
        args: List of string arguments
    Returns:
        str: Test result
    """
    return f"Test function called with {len(args)} arguments: {', '.join(args)}" 