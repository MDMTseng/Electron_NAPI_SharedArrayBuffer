class Throttle {
    constructor(delay = 100) {
        this.delay = delay;
        this.timer = null;
        this.lastRun = 0;
        this.queued = false;
    }

    /**
     * Schedule a function to be executed
     * @param {Function} fn The function to throttle
     * @param {boolean} [immediate=false] Whether to run immediately if possible
     * @returns {Promise<void>} A promise that resolves when the function executes
     */
    schedule(fn, immediate = false) {
        return new Promise((resolve) => {
            const now = Date.now();
            const timeSinceLastRun = now - this.lastRun;

            // Clear any existing timer
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }

            // If enough time has passed and immediate execution is requested, run now
            if (timeSinceLastRun >= this.delay && immediate) {
                this.lastRun = now;
                fn();
                resolve();
                return;
            }

            // Otherwise, schedule for later
            this.timer = setTimeout(() => {
                this.lastRun = Date.now();
                fn();
                this.timer = null;
                resolve();
            }, Math.max(0, this.delay - timeSinceLastRun));
        });
    }

    /**
     * Cancel any pending execution
     */
    cancel() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /**
     * Change the delay time
     * @param {number} newDelay New delay in milliseconds
     */
    setDelay(newDelay) {
        this.delay = newDelay;
    }

    /**
     * Check if there's a pending execution
     * @returns {boolean}
     */
    isPending() {
        return this.timer !== null;
    }

    /**
     * Get time until next possible execution
     * @returns {number} Milliseconds until next possible execution
     */
    getTimeUntilNextRun() {
        const timeSinceLastRun = Date.now() - this.lastRun;
        return Math.max(0, this.delay - timeSinceLastRun);
    }
}

// Export for both CommonJS and ES modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Throttle;
} else {
    window.Throttle = Throttle;
} 