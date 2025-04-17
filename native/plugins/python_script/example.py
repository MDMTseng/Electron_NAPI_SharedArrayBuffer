def main(args):
    """
    Main function that can be called from C++
    Args:
        args: List of string arguments passed from C++
    Returns:
        str: A formatted string with the received arguments
    """
    return f"Hello from Python main! Received {len(args)} arguments: {', '.join(args)}"

def process_data(args):
    """
    Example function that processes data
    Args:
        args: List of string arguments containing data to process
    Returns:
        str: Processed result
    """
    if not args:
        return "Error: No data provided"
    
    # Example processing: convert strings to uppercase and join them
    processed = [arg.upper() for arg in args]
    return f"Processed data: {' '.join(processed)}"

def calculate_sum(args):
    """
    Example function that performs calculations
    Args:
        args: List of string arguments containing numbers
    Returns:
        str: Sum of the numbers or error message
    """
    try:
        numbers = [float(arg) for arg in args]
        total = sum(numbers)
        return f"Sum of numbers: {total}"
    except ValueError:
        return "Error: All arguments must be numbers"

if __name__ == "__main__":
    # This block will only run if the script is executed directly
    # It won't run when imported as a module from C++
    print("This script is meant to be imported and called from C++") 